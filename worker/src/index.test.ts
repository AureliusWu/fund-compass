import { describe, expect, it } from 'vitest'
import { formatMessage, normalizeEstimate, type Estimate } from './index'

describe('Cloudflare push worker', () => {
  it('normalizes a Tiantian estimate', () => {
    const result = normalizeEstimate({ name: '测试基金', dwjz: '1.0', gsz: '1.02', gztime: '2026-07-11 14:30' }, '000001')
    expect(result.change).toBeCloseTo(2)
    expect(result.label).toBe('盘中估值')
  })

  it('formats estimates with decisions', () => {
    const estimate: Estimate = { code: '000001', name: '测试基金', lastNav: 1, estNav: 1.02, change: 2, time: '2026-07-11 14:30', label: '盘中估值' }
    const message = formatMessage(
      [{ code: '000001', name: '测试基金' }],
      new Map([['000001', estimate]]),
      { decisions: [{ code: '000001', action: '继续定投', summary: '维持计划' }] },
    )
    expect(message).toContain('+2.00%（盘中估值）')
    expect(message).toContain('继续定投')
  })
})
