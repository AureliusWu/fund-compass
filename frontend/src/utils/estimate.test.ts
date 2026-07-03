import { describe, expect, it } from 'vitest'

import { applyOverseasModelEstimate, normalizeEstimate } from './estimate'

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

  it('replaces target QDII stale valuation with holdings-through overseas model', () => {
    const e = normalizeEstimate({
      fundcode: '012920',
      name: '易方达全球成长精选混合(QDII)人民币A',
      dwjz: '5',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })
    const modeled = applyOverseasModelEstimate(e, {
      usTSM: { changePct: -2 },
      usLITE: { changePct: -9 },
      sz300502: { changePct: 3 },
      usGLW: { changePct: -1 },
      usAXTI: { changePct: -4 },
      sz300308: { changePct: 2 },
      sh688498: { changePct: 1 },
      usTSEM: { changePct: -3 },
      usGOOGL: { changePct: -1 },
      sz002384: { changePct: 2 },
    })

    expect(modeled.kind).toBe('overseas_model')
    expect(modeled.label).toBe('海外模型估算')
    expect(modeled.isRealtime).toBe(true)
    expect(modeled.modelWeight).toBeCloseTo(51.83)
    expect(modeled.estChange).toBeLessThan(-1)
    expect(modeled.estNav).toBeCloseTo(5 * (1 + modeled.estChange! / 100))
  })

  it('keeps overseas stale valuation when model quotes are too sparse', () => {
    const e = normalizeEstimate({
      fundcode: '539002',
      name: '建信新兴市场混合(QDII)A',
      dwjz: '2.8',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })
    const modeled = applyOverseasModelEstimate(e, { usTSM: { changePct: -2 } })

    expect(modeled.kind).toBe('overseas')
    expect(modeled.isRealtime).toBe(false)
    expect(modeled.estChange).toBeCloseTo(0.01)
  })
})
