import { describe, expect, it } from 'vitest'

import { overseasAccuracyRows, toCSV } from './export'

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

  it('keeps overseas audit states distinct in exported rows', () => {
    const rows = overseasAccuracyRows({
      updated_at: '2026-07-10', summary: {}, records: [{
        code: '018147', name: '测试', target_nav_date: '2026-07-02',
        base_nav_date: '2026-06-30', status: 'observed_only', actual_change: -12.09,
      }],
    })
    expect(rows[0].状态).toBe('observed_only')
    expect(rows[0].净值归属日).toBe('2026-07-02')
  })
})
