import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyOverseasModelEstimate,
  fetchEstimate,
  fetchEstimates,
  holdingsToOverseasModel,
  latestNavMove,
  normalizeEstimate,
  preferredDailyMove,
} from './estimate'

afterEach(() => vi.unstubAllGlobals())

describe('estimate proxy', () => {
  it('loads a batch through the Worker instead of browser-side Eastmoney JSONP', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/estimates?codes=123456')
      return Response.json({ items: [{
        code: '123456', name: '代理测试基金', last_nav: 1, est_nav: 1.01,
        est_change: 1, nav_date: '2026-07-21', est_time: '2026-07-22',
      }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const rows = await fetchEstimates(['123456'])
    expect(rows.get('123456')).toMatchObject({ estChange: 1, isRealtime: false, label: '延迟估值' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous value and marks it stale when the proxy later fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{
        code: '123457', name: '缓存测试基金', last_nav: 1, est_nav: 1.02,
        est_change: 2, nav_date: '2026-07-21', est_time: '2026-07-22',
      }] }))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    expect((await fetchEstimate('123457', true))?.estChange).toBe(2)
    const stale = await fetchEstimate('123457', true)
    expect(stale).toMatchObject({ estChange: 2, isRealtime: false })
    expect(stale?.sourceNote).toContain('代理请求失败，保留上次数据')
  })
})

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

  it('does not present date-only estimate-table data as realtime', () => {
    const e = normalizeEstimate({
      fundcode: '000001', name: '测试基金', dwjz: '1', gsz: '1.01', gszzl: '1',
      jzrq: '2026-07-21', gztime: '2026-07-22', sourcePrecision: 'date',
    })
    expect(e.isRealtime).toBe(false)
    expect(e.label).toBe('延迟估值')
    expect(e.sourceNote).toContain('未提供精确分钟')
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

  it('uses the calibrated style-factor model for 012920 when factor quotes are available', () => {
    const e = normalizeEstimate({
      fundcode: '012920',
      name: '易方达全球成长精选混合(QDII)人民币A',
      dwjz: '5',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })
    const modeled = applyOverseasModelEstimate(e, {
      usQQQ: { changePct: -2 },
      usSOXX: { changePct: -3 },
      sh000300: { changePct: 1 },
      usTSM: { changePct: 5 },
    })

    expect(modeled.kind).toBe('overseas_model')
    expect(modeled.modelWeight).toBeCloseTo(100)
    expect(modeled.modelCode).toBe('usQQQ:45,usSOXX:30,sh000300:25')
    expect(modeled.estChange).toBeCloseTo(-2.17)
  })

  it('replaces 018147 overseas stale valuation with its QDII holdings model', () => {
    const e = normalizeEstimate({
      fundcode: '018147',
      name: '建信新兴市场混合(QDII)C',
      dwjz: '2.4',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })
    const modeled = applyOverseasModelEstimate(e, {
      usTSM: { changePct: 1 },
      usNVDA: { changePct: 2 },
      usEWY: { changePct: -1 },
      usAVGO: { changePct: 3 },
      usSNDK: { changePct: 2 },
      usGLW: { changePct: 1 },
      usWDC: { changePct: -2 },
      usLITE: { changePct: 4 },
      usMPWR: { changePct: 1 },
    })

    expect(modeled.kind).toBe('overseas_model')
    expect(modeled.isRealtime).toBe(true)
    expect(modeled.modelWeight).toBeCloseTo(64.33)
    expect(modeled.estNav).toBeCloseTo(2.4 * (1 + modeled.estChange! / 100))
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

  it('builds a holdings-through model from public top holdings', () => {
    const model = holdingsToOverseasModel([
      { code: 'TSM', name: '台积电', ratio: 8.88 },
      { code: '300502', name: '新易盛', ratio: 6.02 },
      { code: '00700', name: '腾讯控股', ratio: 5 },
      { code: '000660', name: 'SK海力士', ratio: 4 },
      { code: 'BAD-CODE', name: '未知', ratio: 9 },
    ])

    expect(model?.label).toBe('十大重仓穿透模型')
    expect(model?.minWeight).toBe(25)
    expect(model?.legs).toEqual([
      { code: 'usTSM', weight: 8.88 },
      { code: 'sz300502', weight: 6.02 },
      { code: 'hk00700', weight: 5 },
      { code: 'usEWY', weight: 4 },
    ])
  })

  it('can apply a generated holdings-through model to an unconfigured overseas fund', () => {
    const e = normalizeEstimate({
      fundcode: '999999',
      name: '测试全球精选(QDII)',
      dwjz: '2',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })
    const model = holdingsToOverseasModel([
      { code: 'TSM', name: '台积电', ratio: 20 },
      { code: 'NVDA', name: '英伟达', ratio: 10 },
      { code: '300502', name: '新易盛', ratio: 5 },
    ])
    const modeled = applyOverseasModelEstimate(e, {
      usTSM: { changePct: -2 },
      usNVDA: { changePct: -4 },
      sz300502: { changePct: 3 },
    }, model)

    expect(modeled.kind).toBe('overseas_model')
    expect(modeled.modelWeight).toBeCloseTo(35)
    expect(modeled.modelCode).toBe('usTSM:20,usNVDA:10,sz300502:5')
    expect(modeled.estChange).toBeCloseTo(-1.8571)
    expect(modeled.estNav).toBeCloseTo(2 * (1 + modeled.estChange! / 100))
  })

  it('keeps stale overseas estimate when generated holdings model has too little usable weight', () => {
    const e = normalizeEstimate({
      fundcode: '999998',
      name: '测试全球精选(QDII)',
      dwjz: '2',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
    })
    const model = holdingsToOverseasModel([
      { code: 'TSM', name: '台积电', ratio: 10 },
      { code: 'NVDA', name: '英伟达', ratio: 8 },
    ])
    const modeled = applyOverseasModelEstimate(e, {
      usTSM: { changePct: -2 },
      usNVDA: { changePct: -4 },
    }, model)

    expect(modeled.kind).toBe('overseas')
    expect(modeled.estChange).toBeCloseTo(0.01)
  })

  it('prefers latest public NAV move for overseas funds over next-NAV estimate', () => {
    const e = normalizeEstimate({
      fundcode: '018147',
      name: '建信新兴市场混合(QDII)C',
      jzrq: '2026-07-02',
      dwjz: '2.4640',
      gsz: '2.4792',
      gszzl: '0.62',
      gztime: '2026-07-03 04:00',
    })
    const move = latestNavMove([
      { date: '2026-06-29', nav: 2.803 },
      { date: '2026-07-01', nav: 2.464 },
    ])
    const daily = preferredDailyMove(e, move, 'QDII')

    expect(daily?.label).toBe('净')
    expect(daily?.change).toBeCloseTo(-12.0942)
    expect(daily?.baseNav).toBeCloseTo(2.803)
  })

  it('keeps intraday estimate as preferred move for non-overseas funds', () => {
    const e = normalizeEstimate({
      fundcode: '000001',
      name: '普通混合A',
      dwjz: '1',
      gsz: '1.02',
      gztime: '2026-07-02 14:30',
    })
    const move = latestNavMove([
      { date: '2026-07-01', nav: 1 },
      { date: '2026-07-02', nav: 0.99 },
    ])
    const daily = preferredDailyMove(e, move, '混合型')

    expect(daily?.label).toBe('估')
    expect(daily?.change).toBeCloseTo(2)
  })
})
