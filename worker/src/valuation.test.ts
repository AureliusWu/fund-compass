import { afterEach, describe, expect, it, vi } from 'vitest'
import estimateWireFixture from '../../contracts/estimate-wire-v8.json'
import { estimateFixture } from './estimate-fixtures.test-support'
import { createExternalRequestBudget, ExternalDataError, externalGet, readBoundedText, readJson } from './external'
import {
  calculateHoldingsModel,
  isOverseasLike,
  isPublishableIntraday,
  normalizeEstimate,
  normalizeEstimateWire,
  parseEstimateTablePayload,
  parseFundHoldings,
  parseFundProfile,
  parseHoldingQuotePayload,
  parseOfficialNavPayload,
  publicValuationItem,
  resolveValuations,
  type Estimate,
  type FundHoldings,
  type HoldingQuote,
} from './valuation'

const now = new Date('2026-08-12T02:00:00Z')

function official(): Estimate {
  const estimate = normalizeEstimate({
    name: '东方人工智能主题混合A', dwjz: 3.5448, gsz: 3.4509,
    gszzl: -2.65, gzrq: '2026-08-10', gxrq: '2026-08-11',
  }, '005844')
  return {
    ...estimate, kind: 'official_nav', source: 'eastmoney_official_nav', status: 'latest_official',
    isFallback: true, baseNav: 3.5448, baseNavDate: '2026-08-10', valueNav: 3.4509,
    valueDate: '2026-08-11', sourceTime: '2026-08-11',
  }
}

function holdings(reportDate = '2026-06-30', count = 10, ratio = 8): FundHoldings {
  return {
    reportDate,
    items: Array.from({ length: count }, (_, index) => ({
      code: `${688001 + index}`, name: `持仓${index}`, ratio,
    })),
  }
}

function quotes(items: FundHoldings, overrides: Partial<HoldingQuote> = {}): Map<string, HoldingQuote> {
  return new Map(items.items.map((item) => [item.code, {
    code: item.code, price: 100, change: 2,
    timestampMs: Date.parse('2026-08-12T01:59:00Z'), sourceTime: '2026-08-12 09:59:00',
    ...overrides,
  }]))
}

afterEach(() => vi.unstubAllGlobals())

describe('v8 cross-runtime estimate wire contract', () => {
  it.each(['qdii_next_nav_estimate_canonical', 'official_nav_change_unknown'])(
    'matches the shared %s fixture from the real public serializer', (id) => {
      const { wire, estimate } = estimateFixture(id)
      const output = publicValuationItem(estimate)
      expect(Object.fromEntries(Object.keys(wire).map((key) => [key, output[key]]))).toStrictEqual(wire)
      expect(normalizeEstimateWire(output)).toMatchObject({ kind: wire.kind, legacy_alias_used: false })
      expect(output.est_realtime).toBe(false)
    },
  )

  it.each<Partial<Estimate>>([
    { targetNavDate: null },
    { targetNavDate: '2026-02-30' },
    { targetNavDate: '2026-08-27', valueDate: '2026-08-27' },
    { targetNavDate: '2026-09-01' },
    { estimateModelVersion: null },
    { estimateModelVersion: ' ' },
    { estimateModelVersion: 123 as unknown as string },
    { estimateModelVersion: 'x'.repeat(121) },
    { sampleCount: null },
    { sampleCount: -1 },
    { sampleCount: 1.5 },
    { sampleCount: 1_000_001 },
    { coverage: null },
    { coverage: -1 },
    { coverage: 101 },
    { uncertainty: null },
    { uncertainty: { mae: NaN, error_p80: 1.3, direction_accuracy: 64.3 } },
    { uncertainty: { mae: 0.74, error_p80: 1001, direction_accuracy: 64.3 } },
    { uncertainty: { mae: 0.74, error_p80: 1.3, direction_accuracy: 101 } },
    { sourceTime: '2026-08-28' },
    { status: 'fresh' },
    { change: null },
  ])('rejects incomplete or contradictory next-NAV evidence: %j', (override) => {
    const { estimate } = estimateFixture('qdii_next_nav_estimate_canonical')
    expect(() => publicValuationItem({ ...estimate, ...override }))
      .toThrowError(expect.objectContaining({ reason: 'schema_invalid' }))
  })

  it('does not promote serialized QDII evidence into the domestic intraday send gate', () => {
    const { estimate } = estimateFixture('qdii_next_nav_estimate_canonical')
    expect(isPublishableIntraday(estimate, '2026-08-31', new Date('2026-08-31T06:30:00Z'))).toBe(false)
    expect(publicValuationItem({
      ...estimate, sampleCount: 0, coverage: 0,
      uncertainty: { mae: 0, error_p80: 0, direction_accuracy: 0 },
    })).toMatchObject({ sample_count: 0, coverage: 0, uncertainty: { mae: 0, error_p80: 0, direction_accuracy: 0 } })
  })

  it('rejects an official NAV whose optional base pair is incomplete without fabricating a move', () => {
    const { estimate } = estimateFixture('official_nav_change_unknown')
    expect(() => publicValuationItem({ ...estimate, baseNav: 1 }))
      .toThrowError(expect.objectContaining({ reason: 'schema_invalid' }))
    expect(() => publicValuationItem({ ...estimate, change: 0 }))
      .toThrowError(expect.objectContaining({ reason: 'schema_invalid' }))
  })

  it('accepts every canonical fixture without using deprecated aliases and rejects conflicts', () => {
    expect(estimateWireFixture.canonical_kinds).toEqual([
      'intraday_estimate', 'qdii_next_nav_estimate', 'holdings_model', 'official_nav', 'unavailable',
    ])
    for (const fixtureCase of estimateWireFixture.cases) {
      if (!fixtureCase.expected.accepted) {
        expect(() => normalizeEstimateWire(fixtureCase.wire), fixtureCase.id)
          .toThrowError(expect.objectContaining({ reason: fixtureCase.expected.reason }))
        continue
      }
      const normalized = normalizeEstimateWire(fixtureCase.wire)
      expect(normalized.kind, fixtureCase.id).toBe(fixtureCase.expected.kind)
      expect(normalized.legacy_alias_used, fixtureCase.id).toBe(false)
      if ('value_nav' in fixtureCase.expected) {
        expect(normalized.value_nav, fixtureCase.id).toBe(fixtureCase.expected.value_nav)
      }
      if ('value_change' in fixtureCase.expected) {
        expect(normalized.value_change, fixtureCase.id).toBe(fixtureCase.expected.value_change)
      }
      if ('estimate_nav' in fixtureCase.expected) {
        expect(normalized.estimate_nav, fixtureCase.id).toBe(fixtureCase.expected.estimate_nav)
      }
      if ('estimate_change' in fixtureCase.expected) {
        expect(normalized.estimate_change, fixtureCase.id).toBe(fixtureCase.expected.estimate_change)
      }
      if ('target_nav_date' in fixtureCase.expected) {
        expect(normalized.target_nav_date, fixtureCase.id).toBe(fixtureCase.expected.target_nav_date)
      }
      if (fixtureCase.id === 'qdii_next_nav_estimate_canonical') {
        expect(normalized).toMatchObject({
          estimate_model_version: 'qdii-fixture-v1', sample_count: 28, coverage: 78.5,
          uncertainty: { mae: 0.74, error_p80: 1.3, direction_accuracy: 64.3 },
        })
      }
      if (fixtureCase.id === 'stale_intraday_estimate') expect(normalized.status).toBe('stale')
    }
  })

  it('serializes official NAV values without relabeling them as estimates', () => {
    expect(publicValuationItem(official())).toMatchObject({
      kind: 'official_nav', value_nav: 3.4509, value_change: -2.65, nav_date: '2026-08-11',
      estimate_nav: null, estimate_change: null, estimate_time: null,
      est_kind: 'official_nav', est_nav: null, est_change: null,
    })
  })

  it('serializes intraday estimates under the canonical kind while retaining deprecated aliases', () => {
    const item = normalizeEstimate({
      name: '盘中样例', dwjz: 1, gsz: 1.01, gszzl: 1,
      gzrq: '2026-08-11', gxrq: '2026-08-12 10:00:00',
    }, '000001')
    expect(publicValuationItem(item)).toMatchObject({
      kind: 'intraday_estimate', value_nav: 1.01, value_change: null, nav_date: null,
      estimate_nav: 1.01, estimate_change: 1, estimate_time: '2026-08-12T10:00:00+08:00',
      est_kind: 'estimate', est_nav: 1.01, est_change: 1,
    })
  })
})

describe('valuation normalization and model boundaries', () => {
  it('keeps null and blank values missing and isolates a partial estimate table', () => {
    expect(normalizeEstimate({ dwjz: null, gsz: '', gszzl: undefined }, '000001')).toMatchObject({
      lastNav: null, estNav: null, change: null,
    })
    const result = parseEstimateTablePayload({ ErrCode: 0, Data: { list: [
      { bzdm: '000001', dwjz: '1', gsz: '1.01', gszzl: '1%', gzrq: '2026-08-11', gxrq: '2026-08-12' },
    ] } }, ['000001', '000002'])
    expect(result.has('000001')).toBe(true)
    expect(result.has('000002')).toBe(false)
    expect(result.get('000001')?.status).toBe('delayed')
    expect(publicValuationItem(result.get('000001')!)).toMatchObject({
      source_time_precision: 'date', est_realtime: false,
    })
    const precise = normalizeEstimate({
      dwjz: '1', gsz: '1.01', gszzl: '1', gzrq: '2026-08-11', gxrq: '2026-08-12 10:00:00',
    }, '000001')
    expect(publicValuationItem(precise)).toMatchObject({
      status: 'fresh', source_time_precision: 'datetime', est_realtime: true,
    })
    const rounded = normalizeEstimate({
      dwjz: '1', gsz: '1.0104', gszzl: '1.04', gzrq: '2026-08-11', gxrq: '2026-08-12 10:00:00',
    }, '000001')
    expect(isPublishableIntraday(rounded, '2026-08-12', now)).toBe(true)
  })

  it('distinguishes an explicit upstream empty estimate table from a broken schema', () => {
    expect(() => parseEstimateTablePayload({ ErrCode: -1, ErrMsg: ' 暂无数据 ', Data: null }, ['005844']))
      .toThrowError(expect.objectContaining({ reason: 'upstream_empty' }))
    expect(() => parseEstimateTablePayload({ ErrCode: -1, ErrMsg: '系统异常', Data: null }, ['005844']))
      .toThrowError(expect.objectContaining({ reason: 'schema_invalid' }))
    expect(() => parseEstimateTablePayload({ ErrCode: 0, Data: null }, ['005844']))
      .toThrowError(expect.objectContaining({ reason: 'schema_invalid' }))
  })

  it('preserves the upstream empty reason when resolving an official fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/FundGuZhi/GetFundGZList')) {
        return Response.json({ ErrCode: -1, ErrMsg: '暂无数据', Data: null })
      }
      if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-08-11', DWJZ: '1.01', JZZZL: '1' },
        { FSRQ: '2026-08-10', DWJZ: '1.00', JZZZL: '0' },
      ] } })
      if (url.includes('/pingzhongdata/')) return new Response('var fS_name = "国内基金";')
      if (url.includes('/FundArchivesDatas.aspx')) return new Response('var apidata={ content:"<table></table>" };')
      throw new Error(`unexpected ${url}`)
    }))

    const batch = await resolveValuations(['005844'], now)
    expect(batch.primaryReason).toBe('upstream_empty')
    expect(batch.estimates.get('005844')).toMatchObject({
      kind: 'official_nav',
      diagnostics: { primary_reason: 'upstream_empty' },
    })
  })

  it('routes an algebraically contradictory primary estimate into official fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/FundGuZhi/GetFundGZList')) return Response.json({ ErrCode: 0, Data: { list: [{
        bzdm: '005844', jjjc: '鍥藉唴娣峰悎', dwjz: '1', gsz: '2', gszzl: '1',
        gzrq: '2026-08-11', gxrq: '2026-08-12 09:59:00',
      }] } })
      if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-08-11', DWJZ: '1.01', JZZZL: '1' },
        { FSRQ: '2026-08-10', DWJZ: '1.00', JZZZL: '0' },
      ] } })
      if (url.includes('/FundArchivesDatas.aspx')) return new Response('var apidata={ content:"<table></table>" };')
      throw new Error(`unexpected ${url}`)
    }))

    const batch = await resolveValuations(['005844'], now)
    const estimate = batch.estimates.get('005844')!
    expect(estimate).toMatchObject({ kind: 'official_nav', status: 'latest_official' })
    expect(estimate.diagnostics.primary_reason).toBe('estimate_incomplete')
    expect(isPublishableIntraday(estimate, '2026-08-12', now)).toBe(false)
  })

  it('never treats fund code 000001 as a stock detail lookup', () => {
    const parsed = parseHoldingQuotePayload({ data: { diff: [{ f12: '000001', f2: 11.26, f3: 1, f124: 1786500000 }] } })
    expect(parsed.get('000001')?.price).toBe(11.26)
    // Quotes are accepted only for explicitly disclosed holding rows; the
    // valuation module exposes no single-stock query derived from a fund code.
    expect(parseFundProfile('var fS_name = "华夏成长混合";')?.name).toBe('华夏成长混合')
  })

  it('sorts and de-duplicates official NAV rows while rejecting bad dates and NAVs', () => {
    const rows = parseOfficialNavPayload({ ErrCode: 0, Data: { LSJZList: [
      { FSRQ: '2026-08-10', DWJZ: '1.00' },
      { FSRQ: '2026-08-12', DWJZ: '1.02', JZZZL: '2' },
      { FSRQ: '2026-08-12', DWJZ: '99' },
      { FSRQ: '2026-02-31', DWJZ: '1' },
      { FSRQ: '2026-08-11', DWJZ: '' },
    ] } })
    expect(rows.map((row) => [row.date, row.nav])).toEqual([
      ['2026-08-12', 1.02], ['2026-08-10', 1],
    ])
  })

  it('binds holdings exclusively to the latest disclosed report table', () => {
    const row = (code: string, ratio: number) => (
      `<tr><td>1</td><td><a>${code}</a></td><td><a>持仓${code}</a></td>`
      + `<td></td><td></td><td></td><td>${ratio}%</td></tr>`
    )
    const payload = `var apidata={ content:"<div><h4>截止至：<font>2026-06-30</font></h4>`
      + `<table><tbody>${row('688001', 10)}${row('688002', 9)}</tbody></table></div>`
      + `<div><h4>截止至：<font>2026-03-31</font></h4>`
      + `<table><tbody>${row('600001', 20)}${row('600002', 20)}${row('600003', 20)}`
      + `${row('600004', 20)}${row('600005', 20)}</tbody></table></div>" };`
    expect(parseFundHoldings(payload)).toEqual({
      reportDate: '2026-06-30',
      items: [
        { code: '688001', name: '持仓688001', ratio: 10 },
        { code: '688002', name: '持仓688002', ratio: 9 },
      ],
    })
    expect(() => parseFundHoldings('var apidata={ content:"<table></table>" };'))
      .toThrowError(expect.objectContaining({ reason: 'schema_invalid' }))
  })

  it('builds an explicit holdings model with complete canonical diagnostics', () => {
    const disclosed = holdings()
    const result = calculateHoldingsModel(official(), disclosed, quotes(disclosed), now)
    expect(result.estimate).toMatchObject({
      kind: 'holdings_model', status: 'modeled', source: 'eastmoney_holdings_model',
      baseNav: 3.4509, baseNavDate: '2026-08-11', valueDate: '2026-08-12',
      coverage: 80, quoteCount: 10, reportDate: '2026-06-30', rejectedCount: 0,
    })
    expect(isPublishableIntraday(result.estimate!, '2026-08-12', now)).toBe(true)
    expect(publicValuationItem(result.estimate!)).toMatchObject({
      status: 'modeled', kind: 'holdings_model', source_time_precision: 'datetime',
      model_coverage: 80, model_quote_count: 10, model_report_date: '2026-06-30',
      est_time: '2026-08-12', est_realtime: false,
    })
    expect(publicValuationItem(result.estimate!).source_time).toMatch(/^2026-08-12T\d{2}:\d{2}:\d{2}\+08:00$/)
  })

  it('rejects stale, future and out-of-range quotes without treating them as today', () => {
    const disclosed = holdings()
    const stale = calculateHoldingsModel(official(), disclosed, quotes(disclosed, {
      timestampMs: Date.parse('2026-08-11T02:00:00Z'), sourceTime: '2026-08-11 10:00:00',
    }), now)
    expect(stale).toMatchObject({ estimate: null, reason: 'holdings_quote_count_low' })
    expect(stale.rejected.quote_stale).toBe(10)

    const future = calculateHoldingsModel(official(), disclosed, quotes(disclosed, {
      timestampMs: Date.parse('2026-08-12T02:06:00Z'), sourceTime: '2026-08-12 10:06:00',
    }), now)
    expect(future.rejected.quote_future).toBe(10)

    const invalid = calculateHoldingsModel(official(), disclosed, quotes(disclosed, { change: 101 }), now)
    expect(invalid.rejected.quote_out_of_range).toBe(10)
  })

  it('rejects same-day quote windows older than 90 minutes and accepts the exact boundary', () => {
    const disclosed = holdings()
    const afternoon = new Date('2026-08-12T06:30:00Z') // 14:30 Beijing
    const morning = quotes(disclosed, {
      timestampMs: Date.parse('2026-08-12T01:30:00Z'), sourceTime: '2026-08-12 09:30:00',
    })
    const stale = calculateHoldingsModel(official(), disclosed, morning, afternoon)
    expect(stale).toMatchObject({ estimate: null, reason: 'quote_window_stale' })
    expect(stale.rejected.quote_stale).toBe(10)

    const lunchBoundary = quotes(disclosed, {
      timestampMs: Date.parse('2026-08-12T03:30:00Z'), sourceTime: '2026-08-12 11:30:00',
    })
    const accepted = calculateHoldingsModel(
      official(), disclosed, lunchBoundary, new Date('2026-08-12T05:00:00Z'),
    )
    expect(accepted.estimate).toMatchObject({ oldestQuoteTime: '2026-08-12 11:30:00' })
    expect(calculateHoldingsModel(
      official(), disclosed, lunchBoundary, new Date('2026-08-12T05:01:00Z'),
    ).reason).toBe('quote_window_stale')
  })

  it('defensively blocks publishing a manually constructed stale holdings model', () => {
    const disclosed = holdings()
    const modeled = calculateHoldingsModel(official(), disclosed, quotes(disclosed), now).estimate!
    const stale = {
      ...modeled,
      sourceTime: '2026-08-12 09:30:00', time: '2026-08-12 09:30:00',
      oldestQuoteTime: '2026-08-12 09:30:00', newestQuoteTime: '2026-08-12 09:31:00',
    }
    expect(isPublishableIntraday(stale, '2026-08-12', new Date('2026-08-12T06:30:00Z'))).toBe(false)
    expect(isPublishableIntraday({
      ...modeled, newestQuoteTime: '2026-08-12 10:06:00', sourceTime: '2026-08-12 10:06:00',
    }, '2026-08-12', now)).toBe(false)
  })

  it('applies the minute freshness window to direct estimate publishing', () => {
    const at = (sourceTime: string): Estimate => normalizeEstimate({
      name: '主估值', dwjz: 1, gsz: 1.01, gszzl: 1,
      gzrq: '2026-08-11', gxrq: sourceTime,
    }, '005844')
    const afternoon = new Date('2026-08-12T06:30:00Z') // 14:30 Beijing
    expect(isPublishableIntraday(at('2026-08-12 09:30:00'), '2026-08-12', afternoon)).toBe(false)
    expect(isPublishableIntraday(at('2026-08-12 14:29:00'), '2026-08-12', afternoon)).toBe(true)
    expect(isPublishableIntraday(at('2026-08-12 14:36:00'), '2026-08-12', afternoon)).toBe(false)
  })

  it('rejects expired/future disclosures and insufficient count or coverage', () => {
    expect(calculateHoldingsModel(official(), holdings('2025-12-01'), new Map(), now).reason)
      .toBe('holdings_report_expired')
    expect(calculateHoldingsModel(official(), holdings('2026-08-13'), new Map(), now).reason)
      .toBe('holdings_report_expired')
    const four = holdings('2026-06-30', 4, 20)
    expect(calculateHoldingsModel(official(), four, quotes(four), now).reason).toBe('holdings_quote_count_low')
    const lowCoverage = holdings('2026-06-30', 10, 4)
    expect(calculateHoldingsModel(official(), lowCoverage, quotes(lowCoverage), now).reason).toBe('holdings_coverage_low')
  })

  it('deduplicates holdings by security code and rejects aggregate coverage above 100%', () => {
    const unique = holdings('2026-06-30', 5, 12)
    const duplicated: FundHoldings = {
      ...unique,
      items: [...unique.items, { ...unique.items[0], code: ` ${unique.items[0].code} `, ratio: 50 }],
    }
    const deduplicated = calculateHoldingsModel(official(), duplicated, quotes(duplicated), now)
    expect(deduplicated.estimate).toMatchObject({ coverage: 60, quoteCount: 5, rejectedCount: 1 })
    expect(deduplicated.rejected.duplicate_security).toBe(1)

    const excessive = holdings('2026-06-30', 10, 10.01)
    expect(calculateHoldingsModel(official(), excessive, quotes(excessive), now).reason)
      .toBe('holdings_coverage_invalid')
  })

  it('requires a valid prior official NAV no more than seven calendar days old', () => {
    const disclosed = holdings()
    const withBaseDate = (valueDate: string): Estimate => ({
      ...official(), valueDate, sourceTime: valueDate,
    })

    expect(calculateHoldingsModel(withBaseDate('2026-08-11'), disclosed, quotes(disclosed), now).estimate)
      .toMatchObject({ baseNavDate: '2026-08-11' })
    const mondayQuotes = quotes(disclosed, {
      timestampMs: Date.parse('2026-08-10T01:59:00Z'), sourceTime: '2026-08-10 09:59:00',
    })
    expect(calculateHoldingsModel(withBaseDate('2026-08-07'), disclosed, mondayQuotes, new Date('2026-08-10T02:00:00Z')).estimate)
      .toMatchObject({ baseNavDate: '2026-08-07' })
    const oldOfficial = { ...withBaseDate('2026-08-04'), baseNavDate: '2026-08-03' }
    expect(calculateHoldingsModel(oldOfficial, disclosed, quotes(disclosed), now).reason)
      .toBe('official_base_expired')
    expect(publicValuationItem(oldOfficial)).toMatchObject({
      kind: 'official_nav', status: 'latest_official', value_date: '2026-08-04', est_realtime: false,
    })
    expect(calculateHoldingsModel(withBaseDate('2026-08-13'), disclosed, quotes(disclosed), now).reason)
      .toBe('official_base_expired')
    expect(calculateHoldingsModel(withBaseDate('2026-02-31'), disclosed, quotes(disclosed), now).reason)
      .toBe('official_base_expired')
    expect(calculateHoldingsModel(withBaseDate('2026-08-12'), disclosed, quotes(disclosed), now).reason)
      .toBe('official_base_not_prior')

    const tuesday = new Date('2026-08-11T02:00:00Z')
    const tuesdayQuotes = quotes(disclosed, {
      timestampMs: Date.parse('2026-08-11T01:59:00Z'), sourceTime: '2026-08-11 09:59:00',
    })
    expect(calculateHoldingsModel(withBaseDate('2026-08-07'), disclosed, tuesdayQuotes, tuesday).reason)
      .toBe('official_base_not_previous_trading_day')
  })

  it('blocks QDII, US, oil, commodity, Europe and Asia names from the generic model', () => {
    for (const name of ['QDII基金', '美国成长', '原油商品', '欧洲精选', '亚洲机会']) {
      expect(isOverseasLike(name)).toBe(true)
    }
    // Representative QDII codes are classified by their names, never by a
    // universal code rule that could silently model an unknown fund.
    expect(isOverseasLike('嘉实美国成长股票(QDII)', 'QDII')).toBe(true) // 000043
    expect(isOverseasLike('博时标普500ETF联接(QDII)', 'QDII')).toBe(true) // 003321
  })

  it('preserves official fallback for a 25-code public-style batch within the model budget', async () => {
    const codes = Array.from({ length: 25 }, (_, index) => String(index + 1).padStart(6, '0'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/FundGuZhi/GetFundGZList')) {
        return Response.json({ ErrCode: 0, Data: { list: codes.map((code) => ({
          bzdm: code, jjjc: `基金${code}`, dwjz: '1', gsz: '1.01', gszzl: '1%',
          gzrq: '2026-08-10', gxrq: '2026-08-11',
        })) } })
      }
      if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-08-11', DWJZ: '1.02', JZZZL: '2' },
        { FSRQ: '2026-08-10', DWJZ: '1.00', JZZZL: '0' },
      ] } })
      if (url.includes('/pingzhongdata/')) return new Response('var fS_name = "国内基金";')
      if (url.includes('/FundArchivesDatas.aspx')) return new Response('var apidata={ content:"<table></table>" };')
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const batch = await resolveValuations(codes, now)
    expect(batch.estimates.size).toBe(25)
    expect(batch.unavailable.size).toBe(0)
    expect([...batch.estimates.values()].every((item) => item.kind === 'official_nav')).toBe(true)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/f10/lsjz'))).toHaveLength(25)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/FundArchivesDatas.aspx'))).toHaveLength(3)
    // Names came from the stale primary rows, so no profile calls are needed:
    // 1 primary + 25 official + 3 bounded holdings attempts = 29 requests.
    expect(fetchMock).toHaveBeenCalledTimes(29)
  })

  it('models a complete same-day date-only primary before public display', async () => {
    const disclosed = holdings()
    const rows = disclosed.items.map((item, index) => (
      `<tr><td>${index + 1}</td><td><a>${item.code}</a></td><td><a>${item.name}</a></td>`
      + `<td></td><td></td><td></td><td>${item.ratio}%</td></tr>`
    )).join('')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/FundGuZhi/GetFundGZList')) return Response.json({ ErrCode: 0, Data: { list: [{
        bzdm: '005844', jjjc: '国内混合', dwjz: '3.4509', gsz: '3.46', gszzl: '0.26',
        gzrq: '2026-08-11', gxrq: '2026-08-12',
      }] } })
      if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-08-11', DWJZ: '3.4509', JZZZL: '1' },
        { FSRQ: '2026-08-10', DWJZ: '3.4167', JZZZL: '0.5' },
      ] } })
      if (url.includes('/FundArchivesDatas.aspx')) return new Response(
        `var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4><table>${rows}</table>" };`,
      )
      if (url.includes('/api/qt/ulist.np/get')) return Response.json({ data: { diff: disclosed.items.map((item) => ({
        f12: item.code, f2: 100, f3: 2, f124: Date.parse('2026-08-12T01:59:00Z') / 1000,
      })) } })
      throw new Error(`unexpected ${url}`)
    }))
    const batch = await resolveValuations(['005844'], now)
    expect(batch.estimates.get('005844')).toMatchObject({ kind: 'holdings_model', status: 'modeled' })
  })

  it('retains a same-day delayed primary when its model fails but never publishes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/FundGuZhi/GetFundGZList')) return Response.json({ ErrCode: 0, Data: { list: [{
        bzdm: '005844', jjjc: '国内混合', dwjz: '1', gsz: '1.01', gszzl: '1',
        gzrq: '2026-08-11', gxrq: '2026-08-12',
      }] } })
      if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-08-11', DWJZ: '1', JZZZL: '1' },
        { FSRQ: '2026-08-10', DWJZ: '0.99', JZZZL: '0.5' },
      ] } })
      if (url.includes('/FundArchivesDatas.aspx')) return new Response(
        'var apidata={ content:"<h4>截止至：<font>2026-06-30</font></h4><table></table>" };',
      )
      throw new Error(`unexpected ${url}`)
    }))
    const batch = await resolveValuations(['005844'], now)
    const delayed = batch.estimates.get('005844')!
    expect(delayed).toMatchObject({ kind: 'estimate', status: 'delayed' })
    expect(delayed.diagnostics.model_reason).toBe('holdings_quote_count_low')
    expect(publicValuationItem(delayed).est_realtime).toBe(false)
    expect(isPublishableIntraday(delayed, '2026-08-12', now)).toBe(false)
  })

  it('downgrades stale or future precise primary rows while keeping a current row realtime', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/FundGuZhi/GetFundGZList')) return Response.json({ ErrCode: 0, Data: { list: [
        { bzdm: '005844', jjjc: '过期主估值', dwjz: '1', gsz: '1.01', gszzl: '1', gzrq: '2026-08-11', gxrq: '2026-08-12 09:30:00' },
        { bzdm: '000006', jjjc: '当前主估值', dwjz: '1', gsz: '1.01', gszzl: '1', gzrq: '2026-08-11', gxrq: '2026-08-12 14:29:00' },
        { bzdm: '000007', jjjc: '未来主估值', dwjz: '1', gsz: '1.01', gszzl: '1', gzrq: '2026-08-11', gxrq: '2026-08-12 14:36:00' },
      ] } })
      if (url.includes('/f10/lsjz')) return Response.json({ ErrCode: 0, Data: { LSJZList: [
        { FSRQ: '2026-08-11', DWJZ: '1', JZZZL: '1' },
        { FSRQ: '2026-08-10', DWJZ: '0.99', JZZZL: '0.5' },
      ] } })
      if (url.includes('/FundArchivesDatas.aspx')) return new Response('var apidata={ content:"<table></table>" };')
      throw new Error(`unexpected ${url}`)
    }))
    const afternoon = new Date('2026-08-12T06:30:00Z')
    const batch = await resolveValuations(['005844', '000006', '000007'], afternoon)

    expect(publicValuationItem(batch.estimates.get('005844')!)).toMatchObject({
      status: 'delayed', source_time_precision: 'datetime', est_time: '2026-08-12 09:30:00',
      est_realtime: false,
    })
    expect(publicValuationItem(batch.estimates.get('000006')!)).toMatchObject({
      status: 'fresh', source_time_precision: 'datetime', est_time: '2026-08-12 14:29:00',
      est_realtime: true,
    })
    expect(publicValuationItem(batch.estimates.get('000007')!)).toMatchObject({
      status: 'delayed', source_time_precision: 'datetime', est_time: '2026-08-12 14:36:00',
      est_realtime: false,
    })
  })

  it('never exceeds the explicit request-attempt budget and accounts every requested code', async () => {
    const codes = Array.from({ length: 25 }, (_, index) => String(index + 1).padStart(6, '0'))
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const batch = await resolveValuations(codes, now, { requestBudget: 5 })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(batch.estimates.size + batch.unavailable.size).toBe(codes.length)
    expect([...batch.unavailable.values()].some((item) => (
      item.reason === 'request_budget_exhausted'
      || item.diagnostics.official_reason === 'request_budget_exhausted'
    ))).toBe(true)
  })
})

describe('bounded external GET', () => {
  it('retries one 429 or 5xx response exactly once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await readJson(await externalGet('https://upstream.test'))).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('charges retry attempts to a local request budget before fetching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const budget = createExternalRequestBudget(1)
    await expect(externalGet('https://upstream.test', {}, { budget }))
      .rejects.toMatchObject({ reason: 'request_budget_exhausted' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(budget).toMatchObject({ limit: 1, used: 1, remaining: 0 })
  })

  it('cancels a chunked body as soon as the streamed byte limit is exceeded', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'))
        controller.enqueue(new TextEncoder().encode('5678'))
      },
      cancel() { cancelled = true },
    })
    await expect(readBoundedText(new Response(body), 5))
      .rejects.toMatchObject({ reason: 'response_too_large' })
    expect(cancelled).toBe(true)
  })

  it('cancels a declared oversized body without reading it', async () => {
    let cancelled = false
    let pulled = false
    const body = new ReadableStream<Uint8Array>({
      pull() { pulled = true },
      cancel() { cancelled = true },
    })
    const response = new Response(body, { headers: { 'Content-Length': '999' } })
    await expect(readBoundedText(response, 5)).rejects.toMatchObject({ reason: 'response_too_large' })
    expect(cancelled).toBe(true)
    expect(pulled).toBe(false)
  })

  it('cancels failed response bodies before retrying or throwing', async () => {
    const cancelled: number[] = []
    const failed = (id: number, status: number) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('private')); controller.close() },
      cancel() { cancelled.push(id) },
    }), { status })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failed(1, 503))
      .mockResolvedValueOnce(failed(2, 404))
    vi.stubGlobal('fetch', fetchMock)
    await expect(externalGet('https://upstream.test')).rejects.toMatchObject({ reason: 'http_4xx' })
    expect(cancelled).toEqual([1, 2])
  })

  it('does not retry a deterministic 4xx and reports a stable reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('private body', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(externalGet('https://upstream.test/secret')).rejects.toMatchObject({
      reason: 'http_4xx', status: 404,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a timeout once and then exposes only network_timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('contains URL and token', 'TimeoutError'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(externalGet('https://upstream.test/?token=secret')).rejects.toEqual(
      expect.objectContaining<Partial<ExternalDataError>>({ reason: 'network_timeout' }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
