import { describe, expect, it } from 'vitest'
import {
  completePortfolioWeights,
  completeFiniteSum,
  costBasisCoverage,
  holdingCostBasis,
  holdingMarketValue,
  valuationCoverage,
} from './portfolioCoverage'

describe('portfolio valuation coverage', () => {
  it('keeps a missing or invalid NAV as null', () => {
    expect(holdingMarketValue(100, null)).toBeNull()
    expect(holdingMarketValue(100, 0)).toBeNull()
    expect(holdingMarketValue(100, Number.NaN)).toBeNull()
    expect(holdingMarketValue(100, 1.25)).toBe(125)
  })

  it('keeps missing cost separate from an explicit zero cost basis', () => {
    expect(holdingCostBasis(100, undefined)).toBeNull()
    expect(holdingCostBasis(100, Number.NaN)).toBeNull()
    expect(holdingCostBasis(100, 0)).toBe(0)
    expect(holdingCostBasis(100, 1.25)).toBe(125)

    const coverage = costBasisCoverage([
      { code: 'a', name: 'A', basis: 0 },
      { code: 'b', name: 'B', basis: null },
    ])
    expect(coverage).toMatchObject({ complete: false, knownCount: 1, totalCount: 2, knownCost: 0 })
    expect(coverage.missing.map((item) => item.code)).toEqual(['b'])
  })

  it('reports the priced subtotal without calling it a complete total', () => {
    const coverage = valuationCoverage([
      { code: 'a', name: 'A', value: 125 },
      { code: 'b', name: 'B', value: null },
    ])

    expect(coverage).toMatchObject({ complete: false, pricedCount: 1, totalCount: 2, pricedValue: 125 })
    expect(coverage.missing.map((item) => item.code)).toEqual(['b'])
  })

  it('refuses to derive portfolio weights until every holding is priced', () => {
    expect(completePortfolioWeights([
      { code: 'a', name: 'A', value: 125 },
      { code: 'b', name: 'B', value: null },
    ])).toBeNull()
    expect(completePortfolioWeights([
      { code: 'a', name: 'A', value: 75 },
      { code: 'b', name: 'B', value: 25 },
    ])).toEqual([75, 25])
  })

  it('does not expose a partial aggregate when one daily value is missing', () => {
    expect(completeFiniteSum([12.5, null, -2])).toBeNull()
    expect(completeFiniteSum([])).toBeNull()
    expect(completeFiniteSum([12.5, 0, -2])).toBe(10.5)
  })
})
