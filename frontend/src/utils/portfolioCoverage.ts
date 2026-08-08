export interface ValuedPosition {
  code: string
  name: string
  value: number | null
}

export interface ValuationCoverage {
  complete: boolean
  pricedCount: number
  totalCount: number
  pricedValue: number
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
  knownCost: number
  missing: CostBasisPosition[]
}

/**
 * A fund position is priced only when both shares and NAV are usable.
 * Missing/invalid NAV stays null so callers cannot silently turn it into cash.
 */
export function holdingMarketValue(shares: number, nav: number | null | undefined): number | null {
  if (!Number.isFinite(shares) || shares <= 0) return null
  if (nav == null || !Number.isFinite(nav) || nav <= 0) return null
  return shares * nav
}

/** Missing unit cost stays null; an explicit zero cost remains a valid zero basis. */
export function holdingCostBasis(shares: number, unitCost: number | null | undefined): number | null {
  if (!Number.isFinite(shares) || shares <= 0) return null
  if (unitCost == null || !Number.isFinite(unitCost) || unitCost < 0) return null
  return shares * unitCost
}

export function valuationCoverage(positions: ValuedPosition[]): ValuationCoverage {
  const missing = positions.filter((position) => position.value == null || !Number.isFinite(position.value))
  const priced = positions.filter(
    (position): position is ValuedPosition & { value: number } => position.value != null && Number.isFinite(position.value),
  )
  return {
    complete: missing.length === 0,
    pricedCount: priced.length,
    totalCount: positions.length,
    pricedValue: priced.reduce((sum, position) => sum + position.value, 0),
    missing,
  }
}

export function costBasisCoverage(positions: CostBasisPosition[]): CostBasisCoverage {
  const missing = positions.filter((position) => position.basis == null || !Number.isFinite(position.basis))
  const known = positions.filter(
    (position): position is CostBasisPosition & { basis: number } => position.basis != null && Number.isFinite(position.basis),
  )
  return {
    complete: missing.length === 0,
    knownCount: known.length,
    totalCount: positions.length,
    knownCost: known.reduce((sum, position) => sum + position.basis, 0),
    missing,
  }
}

/** Returns null unless every position is priced and the portfolio total is positive. */
export function completePortfolioWeights(positions: ValuedPosition[]): number[] | null {
  const coverage = valuationCoverage(positions)
  if (!coverage.complete || !(coverage.pricedValue > 0)) return null
  return positions.map((position) => (position.value as number) / coverage.pricedValue * 100)
}

/** Aggregate metrics such as today's P/L are available only with full finite coverage. */
export function completeFiniteSum(values: Array<number | null | undefined>): number | null {
  if (!values.length || values.some((value) => value == null || !Number.isFinite(value))) return null
  return values.reduce<number>((sum, value) => sum + (value as number), 0)
}
