export interface ValuedPosition {
  code: string
  name: string
  value: number | null
}

export interface ValuationCoverage {
  complete: boolean
  pricedCount: number
  totalCount: number
  pricedValue: number | null
  missing: ValuedPosition[]
}

export interface CostBasisPosition {
  code: string
  name: string
  basis: number | null
}

export interface CostBasisCoverage {
  complete: boolean
  knownCount: number
  totalCount: number
  knownCost: number | null
  missing: CostBasisPosition[]
}

/**
 * A fund position is priced only when both shares and NAV are usable.
 * Missing/invalid NAV stays null so callers cannot silently turn it into cash.
 */
export function holdingMarketValue(shares: number, nav: number | null | undefined): number | null {
  if (!Number.isFinite(shares) || shares <= 0) return null
  if (nav == null || !Number.isFinite(nav) || nav <= 0) return null
  const value = shares * nav
  return Number.isFinite(value) ? value : null
}

/** Missing unit cost stays null; an explicit zero cost remains a valid zero basis. */
export function holdingCostBasis(shares: number, unitCost: number | null | undefined): number | null {
  if (!Number.isFinite(shares) || shares <= 0) return null
  if (unitCost == null || !Number.isFinite(unitCost) || unitCost < 0) return null
  const basis = shares * unitCost
  return Number.isFinite(basis) ? basis : null
}

export function valuationCoverage(positions: ValuedPosition[]): ValuationCoverage {
  const missing = positions.filter((position) => position.value == null || !Number.isFinite(position.value))
  const priced = positions.filter(
    (position): position is ValuedPosition & { value: number } => position.value != null && Number.isFinite(position.value),
  )
  const sum = priced.reduce((total, position) => total + position.value, 0)
  const pricedValue = Number.isFinite(sum) ? sum : null
  return {
    complete: missing.length === 0 && pricedValue != null,
    pricedCount: priced.length,
    totalCount: positions.length,
    pricedValue,
    missing,
  }
}

export function costBasisCoverage(positions: CostBasisPosition[]): CostBasisCoverage {
  const missing = positions.filter((position) => position.basis == null || !Number.isFinite(position.basis))
  const known = positions.filter(
    (position): position is CostBasisPosition & { basis: number } => position.basis != null && Number.isFinite(position.basis),
  )
  const sum = known.reduce((total, position) => total + position.basis, 0)
  const knownCost = Number.isFinite(sum) ? sum : null
  return {
    complete: missing.length === 0 && knownCost != null,
    knownCount: known.length,
    totalCount: positions.length,
    knownCost,
    missing,
  }
}

/** Returns null unless every position is priced and the portfolio total is positive. */
export function completePortfolioWeights(positions: ValuedPosition[]): number[] | null {
  const coverage = valuationCoverage(positions)
  const total = coverage.pricedValue
  if (!coverage.complete || total == null || !(total > 0)) return null
  const weights = positions.map((position) => (position.value as number) / total * 100)
  return weights.every(Number.isFinite) ? weights : null
}

/** Aggregate metrics such as today's P/L are available only with full finite coverage. */
export function completeFiniteSum(values: Array<number | null | undefined>): number | null {
  if (!values.length || values.some((value) => value == null || !Number.isFinite(value))) return null
  const total = values.reduce<number>((sum, value) => sum + (value as number), 0)
  return Number.isFinite(total) ? total : null
}
