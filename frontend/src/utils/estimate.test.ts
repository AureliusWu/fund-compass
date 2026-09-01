import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  applyOverseasModelEstimate,
  fetchEstimate,
  fetchEstimates,
  holdingsToOverseasModel,
  estimateDataFreshness,
  latestNavMove,
  loadCachedEstimates,
  normalizeEstimate,
  parseEstimateWireRow,
  preferredDailyMove,
  saveCachedEstimates,
} from './estimate'

const wireFixture = JSON.parse(readFileSync(
  new URL('../../../contracts/estimate-wire-v8.json', import.meta.url),
  'utf8',
)) as {
  cases: Array<{
    id: string
    wire: Record<string, unknown>
    expected: Record<string, unknown> & { accepted: boolean }
  }>
}

afterEach(() => vi.unstubAllGlobals())

describe('estimate proxy', () => {
  it('normalizes the shared cross-runtime wire fixtures without mixing valuation axes', () => {
    for (const fixture of wireFixture.cases) {
      const parsed = parseEstimateWireRow(fixture.wire, {
        status: String(fixture.wire.status || ''),
        source: String(fixture.wire.source || ''),
        fallback: null,
        fetchedAt: null,
      })
      if (!fixture.expected.accepted) {
        expect(parsed, fixture.id).toBeNull()
        continue
      }
      expect(parsed, fixture.id).not.toBeNull()
      const estimate = normalizeEstimate(parsed!)
      expect(estimate.contractKind, fixture.id).toBe(fixture.expected.kind)
      expect(estimate.legacyEstimateAliasUsed, fixture.id).toBe(fixture.expected.legacy_alias_used)

      if (fixture.id === 'official_nav_canonical') {
        expect(estimate).toMatchObject({
          kind: 'official_nav', valueNav: 1.02, valueChange: 2,
          navDate: '2026-08-28', estNav: null, estChange: null,
        })
      } else if (fixture.id === 'official_nav_change_unknown') {
        expect(estimate).toMatchObject({
          kind: 'official_nav', valueNav: 1.02, valueChange: null,
          navDate: '2026-08-28', estNav: null, estChange: null,
        })
      } else if (fixture.id === 'intraday_estimate_canonical') {
        expect(estimate).toMatchObject({
          kind: 'intraday', valueNav: 1.01, valueChange: null,
          estNav: 1.01, estChange: 1, targetNavDate: null,
        })
      } else if (fixture.id === 'qdii_next_nav_estimate_canonical') {
        expect(estimate).toMatchObject({
          kind: 'overseas_model', contractKind: 'qdii_next_nav_estimate', isRealtime: false,
          targetNavDate: '2026-08-31', modelVersion: 'qdii-fixture-v1',
          sampleCount: 28, modelCoverage: 78.5, errorP80: 1.3,
        })
      } else if (fixture.id === 'stale_intraday_estimate') {
        expect(estimateDataFreshness(estimate, Date.parse('2026-08-28T10:00:00+08:00'))).toBe('expired')
      } else if (fixture.id === 'unavailable_nulls') {
        expect(estimate).toMatchObject({
          kind: 'unavailable', valueNav: null, valueChange: null, estNav: null, estChange: null,
        })
      }
    }
  })

  it('fails closed when a canonical QDII estimate omits required uncertainty evidence', () => {
    const fixture = wireFixture.cases.find((item) => item.id === 'qdii_next_nav_estimate_canonical')!
    const malformed = structuredClone(fixture.wire)
    const uncertainty = malformed.uncertainty as Record<string, unknown>
    delete uncertainty.direction_accuracy

    expect(parseEstimateWireRow(malformed, {
      status: String(malformed.status || ''),
      source: String(malformed.source || ''),
      fallback: null,
      fetchedAt: null,
    })).toBeNull()
  })

  it('renders a safe local estimate snapshot before the network refresh', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const estimate = normalizeEstimate({
      fundcode: '123450', name: '首屏缓存基金', dwjz: '1', gsz: '1.01',
      gszzl: '1', jzrq: '2026-07-31', gztime: '2026-08-01', sourcePrecision: 'date',
    })

    saveCachedEstimates([estimate], storage)
    const cached = loadCachedEstimates(['123450'], storage).get('123450')

    expect(cached).toMatchObject({ code: '123450', estChange: 1, cached: true, isRealtime: false })
    expect(cached?.sourceNote).toContain('本地缓存，正在后台更新')
  })

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

  it('shows the latest official NAV move when the market is closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{
      code: '123458', name: '休市测试基金', last_nav: 1, est_nav: 1.02,
      est_change: 2, nav_date: '2026-07-23', est_time: '2026-07-24',
      est_kind: 'official_nav', est_label: '最近净值',
      est_note: '盘中估值不可用；展示最近两个已公布正式净值的涨跌',
    }] })))

    const estimate = (await fetchEstimates(['123458'])).get('123458')
    expect(estimate).toMatchObject({
      kind: 'official_nav',
      label: '最近净值',
      valueChange: 2,
      estNav: null,
      estChange: null,
      estTime: '2026-07-24',
      isRealtime: false,
    })
    expect(preferredDailyMove(
      estimate, null, '普通混合A', Date.parse('2026-07-27T10:00:00+08:00'),
    )).toMatchObject({
      change: 2,
      label: '净',
      date: '2026-07-24',
    })
  })

  it('accepts the v7 holdings-model contract without presenting it as realtime', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => Response.json({
      status: 'degraded', source: 'holdings_model', fallback: 'holdings_model',
      fetched_at: '2026-08-12T02:03:00Z',
      items: [{
        code: '005844', name: '东方人工智能',
        base_nav: 3.4509, base_nav_date: '2026-08-11',
        value_nav: 3.513, value_date: '2026-08-12', est_change: 1.8,
        est_time: '2026-08-12 10:02:54', source_time_precision: 'datetime',
        est_kind: 'holdings_model', status: 'modeled', source: 'holdings_model',
        model_coverage: 83.47, model_quote_count: 10, model_report_date: '2026-06-30',
        model_oldest_quote_time: '2026-08-12 10:02:39', model_newest_quote_time: '2026-08-12 10:02:54',
        model_rejected_count: 0,
        provider_diagnostics: [{ provider: 'eastmoney_quotes', status: 'ok', fetched_at: '2026-08-12T02:03:00Z' }],
      }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const estimate = (await fetchEstimates(['005844'])).get('005844')
    expect(estimate).toMatchObject({
      kind: 'holdings_model', label: '重仓模型估算', isRealtime: false,
      baseNav: 3.4509, baseNavDate: '2026-08-11', valueNav: 3.513, valueDate: '2026-08-12',
      lastNav: 3.4509, navDate: '2026-08-11', estNav: 3.513,
      status: 'modeled', source: 'holdings_model', responseStatus: 'degraded',
      responseSource: 'holdings_model', responseFallback: 'holdings_model',
      modelCoverage: 83.47, modelQuoteCount: 10, modelReportDate: '2026-06-30',
    })
    expect(estimate?.providerDiagnostics).toEqual([expect.objectContaining({ provider: 'eastmoney_quotes', status: 'ok' })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/estimates?codes=005844')
  })

  it('keeps a real date-precision v7 wire row explicitly non-realtime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      status: 'ok', source: 'eastmoney_estimate_table', items: [{
        code: '000006', name: '日期精度基金',
        base_nav: 1, base_nav_date: '2026-08-11',
        value_nav: 1.01, value_date: '2026-08-12', est_change: 1,
        est_time: '2026-08-12', source_time_precision: 'date',
        est_kind: 'estimate', est_realtime: false, status: 'delayed',
      }],
    })))

    const estimate = await fetchEstimate('000006', true)
    expect(estimate).toMatchObject({
      code: '000006', kind: 'intraday', label: '延迟估值',
      estTime: '2026-08-12', valueDate: '2026-08-12', isRealtime: false, status: 'delayed',
    })
  })

  it('keeps fund code 000001 on the Worker estimates route without a stock-quote fallback', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      expect(url).toContain('/estimates?codes=000001')
      expect(url).not.toMatch(/(?:stock|quote|push2)/i)
      return Response.json({
        status: 'modeled',
        source: 'holdings_model',
        items: [{
          code: '000001', name: 'Worker modeled fund',
          base_nav: 1, base_nav_date: '2026-08-11',
          value_nav: 1.01, value_date: '2026-08-12', est_change: 1,
          est_time: '2026-08-12 10:03:00', est_kind: 'holdings_model',
          model_coverage: 75, model_quote_count: 8,
        }],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const estimate = await fetchEstimate('000001', true)
    expect(estimate).toMatchObject({ code: '000001', kind: 'holdings_model', isRealtime: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('chunks large batches, deduplicates codes and isolates one failed chunk', async () => {
    const codes = Array.from({ length: 56 }, (_, index) => String(700000 + index))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input)).searchParams.get('codes')!.split(',')
      expect(requested.length).toBeLessThanOrEqual(25)
      if (requested.includes('700025')) throw new Error('one provider batch failed')
      return Response.json({
        status: 'ok', source: 'estimate', fetched_at: '2026-08-12T02:00:00Z',
        items: requested.map((code) => ({
          code, name: `基金${code}`, last_nav: 1, est_nav: 1.01, est_change: 1,
          nav_date: '2026-08-11', est_time: '2026-08-12',
        })),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rows = await fetchEstimates([...codes, codes[0], 'bad'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(rows.size).toBe(56)
    expect(rows.get('700000')?.estChange).toBe(1)
    expect(rows.get('700025')).toBeNull()
    expect(rows.get('700050')?.estChange).toBe(1)
  })

  it('deduplicates concurrent identical proxy requests in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      await gate
      const requested = new URL(String(input)).searchParams.get('codes')!.split(',')
      return Response.json({ items: requested.map((code) => ({
        code, name: code, last_nav: 1, est_nav: 1, est_change: 0,
        nav_date: '2026-08-11', est_time: '2026-08-12',
      })) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = fetchEstimates(['820002', '820001', '820001'])
    const second = fetchEstimates(['820001', '820002'])
    release()
    const [a, b] = await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.get('820001')?.estChange).toBe(0)
    expect(b.get('820002')?.estChange).toBe(0)
  })
})

describe('normalizeEstimate', () => {
  it('keeps explicit null, undefined, blank and numeric garbage missing while preserving a real zero change', () => {
    const missing = normalizeEstimate({
      fundcode: '000001', name: '空值测试', baseNav: null, dwjz: '1.23',
      valueNav: '1.24junk', gszzl: ' -- ', gztime: '2026-08-12 10:00',
    })
    expect(missing.baseNav).toBeNull()
    expect(missing.valueNav).toBeNull()
    expect(missing.estChange).toBeNull()

    const explicitUndefined = normalizeEstimate({
      fundcode: '000002', name: 'undefined 测试', baseNav: undefined, dwjz: '1.23',
      valueNav: undefined, gsz: '1.24', gszzl: undefined, gztime: '2026-08-12 10:00',
    })
    expect(explicitUndefined.baseNav).toBeNull()
    expect(explicitUndefined.valueNav).toBeNull()
    expect(explicitUndefined.estChange).toBeNull()

    const zero = normalizeEstimate({
      fundcode: '000004', name: '零涨跌测试', baseNav: '1', valueNav: '',
      gszzl: '0', gztime: '2026-08-12 10:00',
    })
    expect(zero.estChange).toBe(0)
    expect(zero.valueNav).toBeNull()
  })

  it('keeps old last-nav fields compatible while exposing separate base and value dates', () => {
    const estimate = normalizeEstimate({
      fundcode: '000003', name: '旧契约', dwjz: '1', gsz: '1.02', gszzl: '2',
      jzrq: '2026-08-11', gztime: '2026-08-12', sourcePrecision: 'date',
    })
    expect(estimate).toMatchObject({
      baseNav: 1, baseNavDate: '2026-08-11', valueNav: 1.02, valueDate: '2026-08-12',
      lastNav: 1, navDate: '2026-08-11', estNav: 1.02, estTime: '2026-08-12',
    })
  })

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

  it('does not publish a QDII next-NAV model without an explicitly bound target NAV date', () => {
    const estimate = normalizeEstimate({
      fundcode: '012920', name: '易方达全球成长精选混合(QDII)人民币A',
      dwjz: '5', gszzl: '0.01', gztime: '2026-07-02 04:00',
    })
    const modeled = applyOverseasModelEstimate(estimate, {
      usQQQ: { changePct: -2 }, usSOXX: { changePct: -3 }, sh000300: { changePct: 1 },
    })

    expect(modeled).toBe(estimate)
    expect(modeled.kind).toBe('overseas')
    expect(modeled.contractKind).toBeUndefined()
    expect(modeled.targetNavDate).toBeNull()
  })

  it('replaces target QDII stale valuation with holdings-through overseas model', () => {
    const e = normalizeEstimate({
      fundcode: '012920',
      name: '易方达全球成长精选混合(QDII)人民币A',
      dwjz: '5',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
      targetNavDate: '2026-07-03',
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
    expect(modeled.isRealtime).toBe(false)
    expect(modeled.modelWeight).toBeCloseTo(51.83)
    expect(modeled.estChange).toBeLessThan(-1)
    expect(modeled.estNav).toBeCloseTo(5 * (1 + modeled.estChange! / 100))
    expect(modeled.valueDate).toBe('2026-07-03')
    expect(modeled.estTime).toBe(modeled.generatedAt)
  })

  it('uses the calibrated style-factor model for 012920 when factor quotes are available', () => {
    const e = normalizeEstimate({
      fundcode: '012920',
      name: '易方达全球成长精选混合(QDII)人民币A',
      dwjz: '5',
      gszzl: '0.01',
      gztime: '2026-07-02 04:00',
      targetNavDate: '2026-07-03',
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
      targetNavDate: '2026-07-03',
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
    expect(modeled.isRealtime).toBe(false)
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
      targetNavDate: '2026-07-03',
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
      targetNavDate: '2026-07-03',
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
      targetNavDate: '2026-07-03',
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
    const daily = preferredDailyMove(e, move, 'QDII', Date.parse('2026-07-02T10:00:00+08:00'))

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
    const daily = preferredDailyMove(e, move, '混合型', Date.parse('2026-07-02T14:31:00+08:00'))

    expect(daily?.label).toBe('估')
    expect(daily?.change).toBeCloseTo(2)
  })

  it('labels a holdings-model daily move explicitly as non-official model data', () => {
    const e = normalizeEstimate({
      fundcode: '005844', name: '国内混合', baseNav: 1, valueNav: 1.04, gszzl: 4,
      baseNavDate: '2026-08-11', valueDate: '2026-08-12',
      gztime: '2026-08-12 10:00:00', estKind: 'holdings_model',
      modelOldestQuoteTime: '2026-08-12 09:59:00', modelNewestQuoteTime: '2026-08-12 10:00:00',
    })
    expect(preferredDailyMove(e, null, '混合型', Date.parse('2026-08-12T10:01:00+08:00'))).toMatchObject({
      label: '重仓模型', change: 4, date: '2026-08-12 10:00:00',
    })
  })

  it('fails closed for expired precise estimates without applying minute age to official NAV', () => {
    const now = Date.parse('2026-08-12T14:30:00+08:00')
    const holdings = (time: string) => normalizeEstimate({
      fundcode: '005844', name: '国内混合', baseNav: 1, valueNav: 1.04, gszzl: 4,
      baseNavDate: '2026-08-11', valueDate: '2026-08-12', gztime: time,
      estKind: 'holdings_model', modelOldestQuoteTime: time, modelNewestQuoteTime: time,
    })
    expect(preferredDailyMove(holdings('2026-08-12 12:59:00'), null, '混合型', now)).toBeNull()
    expect(preferredDailyMove(holdings('2026-08-12 14:29:00'), null, '混合型', now))
      .toMatchObject({ label: '重仓模型', change: 4 })

    const intraday = normalizeEstimate({
      fundcode: '000006', name: '盘中估值', dwjz: 1, gsz: 1.04, gszzl: 4,
      jzrq: '2026-08-11', gztime: '2026-08-12 12:59:00', sourcePrecision: 'datetime',
    })
    expect(preferredDailyMove(intraday, null, '混合型', now)).toBeNull()

    const overseasModel = {
      ...holdings('2026-08-12 14:29:00'),
      kind: 'overseas_model' as const,
      label: '海外模型估算' as const,
      generatedAt: '2026-08-07T06:29:00Z',
    }
    expect(preferredDailyMove(overseasModel, null, 'QDII', now)).toBeNull()

    const official = normalizeEstimate({
      fundcode: '005844', name: '正式净值', dwjz: 1, gsz: 1.04, gszzl: 4,
      jzrq: '2026-08-10', gztime: '2026-08-11', estKind: 'official_nav',
    })
    expect(preferredDailyMove(official, null, '混合型', now))
      .toMatchObject({ label: '净', change: 4, date: '2026-08-11' })
  })
})
