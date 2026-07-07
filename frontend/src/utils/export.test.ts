import { describe, expect, it } from 'vitest'

import { toCSV } from './export'

describe('toCSV', () => {
  it('returns empty string for empty rows', () => {
    expect(toCSV([])).toBe('')
  })

  it('escapes comma quote and newline for Excel-friendly CSV', () => {
    const csv = toCSV([
      { 代码: '510300', 名称: '沪深300,增强"测试"', 备注: '第一行\n第二行' },
    ])
    expect(csv).toBe('代码,名称,备注\n510300,"沪深300,增强""测试""","第一行\n第二行"')
  })
})
