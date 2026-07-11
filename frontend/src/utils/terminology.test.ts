import { describe, expect, it } from 'vitest'
import { temperatureLabel } from './terminology'

describe('temperature terminology', () => {
  it('uses one stable band definition across the site', () => {
    expect([20, 21, 41, 61, 81].map(temperatureLabel)).toEqual(['清冷', '偏冷', '适中', '偏热', '过热'])
    expect(temperatureLabel(null)).toBe('计算中')
  })
})
