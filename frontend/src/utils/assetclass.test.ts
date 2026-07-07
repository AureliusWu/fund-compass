import { describe, expect, it } from 'vitest'

import { classifyFundType, computeAssetClass } from './assetclass'

describe('assetclass manual assets', () => {
  it('classifies manual cash stock and gold assets', () => {
    expect(classifyFundType('现金').cls).toBe('现金')
    expect(classifyFundType('股票').cls).toBe('权益')
    expect(classifyFundType('黄金').cls).toBe('商品')
  })

  it('includes commodity in allocation', () => {
    const r = computeAssetClass([
      { value: 100, type: '股票' },
      { value: 50, type: '黄金' },
      { value: 50, type: '现金' },
    ])
    expect(r.totalValue).toBe(200)
    expect(r.classes.map((c) => c.cls)).toEqual(['权益', '现金', '商品'])
    expect(r.classes.find((c) => c.cls === '商品')?.pct).toBeCloseTo(25)
  })
})
