import { describe, expect, it } from 'vitest'

import { normalizeEstimate } from './estimate'

describe('normalizeEstimate', () => {
  it('labels QDII early-morning valuation as overseas estimate', () => {
    const e = normalizeEstimate({
      fundcode: '539002',
      name: '建信新兴市场混合(QDII)A',
      jzrq: '2026-06-30',
      dwjz: '2.8470',
      gsz: '2.8474',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })

    expect(e.kind).toBe('overseas')
    expect(e.label).toBe('海外估值')
    expect(e.isRealtime).toBe(false)
    expect(e.sourceNote).toContain('未提供实时盘中估值')
    expect(e.estChange).toBeCloseTo(0.01)
    expect(e.estNav).toBeCloseTo(2.8474)
  })

  it('derives missing estimate nav from last nav and change percent', () => {
    const e = normalizeEstimate({
      fundcode: '012920',
      name: '易方达全球成长精选混合(QDII)人民币A',
      dwjz: '5.2809',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })

    expect(e.kind).toBe('overseas')
    expect(e.estNav).toBeCloseTo(5.2809 * 1.0001)
  })

  it('derives missing change percent from last nav and estimate nav', () => {
    const e = normalizeEstimate({
      fundcode: '000001',
      name: '普通混合A',
      dwjz: '1',
      gsz: '1.02',
      gztime: '2026-07-02 14:30',
    })

    expect(e.kind).toBe('intraday')
    expect(e.label).toBe('盘中估值')
    expect(e.isRealtime).toBe(true)
    expect(e.estChange).toBeCloseTo(2)
  })
})
