import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accuracyEffectiveAt, attachAccuracy, loadOverseasAccuracy } from './overseasAccuracy'
import type { Estimate } from './estimate'
import currentOverseasLedger from '../../public/data/overseas-accuracy.json'

describe('overseas accuracy metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T16:00:00Z'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        updated_at: '2026-07-10',
        pipeline: {
          heartbeat_at: '2026-07-10T23:55:00+08:00',
          last_effective_settlement_at: '2026-07-10T14:35:00+08:00',
        },
        summary: {
          '012920': {
            model_version: 'active-v1', samples: 24, status: 'healthy', confidence: '中等',
            mae: 1.2, bias: 0.1, direction_accuracy: 70, error_band: 1.8,
          },
        },
        records: [{
          code: '012920', status: 'settled', model_version: 'active-v1',
          prediction_date: '2026-07-10', target_nav_date: '2026-07-09', base_nav_date: '2026-07-08',
          observed_at: '2026-07-10T14:00:00+08:00', settled_at: '2026-07-10T14:35:00+08:00',
          alignment_version: 'observation-target-v2', predicted_change: 1, actual_change: 0.5, error: 0.5,
        }],
      }),
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('attaches sample-backed confidence to a modeled estimate', async () => {
    await loadOverseasAccuracy(true)
    const estimate: Estimate = {
      code: '012920', name: '测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
      baseNav: 4, baseNavDate: '2026-07-09', valueNav: 4.1, valueDate: '2026-07-10',
      navDate: '2026-07-09', estTime: '2026-07-10 14:30',
      kind: 'overseas_model', label: '海外模型估算', isRealtime: true,
      sourceNote: '风格模型', modelWeight: 100, modelVersion: 'active-v1',
    }
    const result = await attachAccuracy(estimate)
    expect(result.confidence).toBe('中等')
    expect(result.accuracySamples).toBe(24)
    expect(result.errorBand).toBe(1.8)
    expect(result.sourceNote).toContain('历史约±1.80%')
    expect(result.accuracyUpdatedAt).toBe('2026-07-10T14:35:00+08:00')
  })

  it('uses effective settlement time instead of a fresh heartbeat', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        updated_at: '2026-07-10T23:59:00+08:00',
        pipeline: {
          heartbeat_at: '2026-07-10T23:59:00+08:00',
          last_effective_settlement_at: '2026-07-01T14:35:00+08:00',
        },
        summary: {
          '012920': {
            model_version: 'active-v1', samples: 24, status: 'healthy', confidence: '中等',
            mae: 1.2, bias: 0.1, direction_accuracy: 70, error_band: 1.8,
          },
        },
        records: [{
          code: '012920', status: 'settled', model_version: 'active-v1',
          prediction_date: '2026-07-01', target_nav_date: '2026-06-30', base_nav_date: '2026-06-29',
          observed_at: '2026-07-01T14:00:00+08:00', settled_at: '2026-07-01T14:35:00+08:00',
          alignment_version: 'observation-target-v2', predicted_change: 1, actual_change: 0.5, error: 0.5,
        }],
      }),
    }))
    await loadOverseasAccuracy(true)
    const estimate: Estimate = {
      code: '012920', name: '测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
      baseNav: 4, baseNavDate: '2026-07-09', valueNav: 4.1, valueDate: '2026-07-10',
      navDate: '2026-07-09', estTime: '2026-07-10 14:30',
      kind: 'overseas_model', label: '海外模型估算', isRealtime: true,
      sourceNote: '风格模型', modelWeight: 100, modelVersion: 'active-v1',
    }
    const result = await attachAccuracy(estimate)
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBe('2026-07-01T14:35:00+08:00')
  })

  it('uses the effective prediction time while samples are still collecting', () => {
    expect(accuracyEffectiveAt({
      updated_at: '2026-07-10T23:59:00+08:00',
      pipeline: {
        last_effective_prediction_at: '2026-07-10T14:40:00+08:00',
        last_effective_settlement_at: '2026-07-01T14:35:00+08:00',
      },
      summary: { '012920': {
        model_version: 'active-v1', samples: 0, status: 'collecting', confidence: '样本积累中',
        mae: null, bias: null, direction_accuracy: null, error_band: null,
      } }, records: [{
        code: '012920', name: '测试QDII', status: 'pending', model_version: 'active-v1',
        prediction_date: '2026-07-10', target_nav_date: '2026-07-09', base_nav_date: '2026-07-08',
        observed_at: '2026-07-10T14:40:00+08:00', alignment_version: 'observation-target-v2', predicted_change: 1,
      }],
    }, '012920', 'active-v1')).toBe('2026-07-10T14:40:00+08:00')
  })

  it('does not present quarantined legacy samples as current precision evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        updated_at: '2026-08-13T10:00:00+08:00',
        pipeline: {
          heartbeat_at: '2026-08-13T10:00:00+08:00',
          alignment_version: 'observation-target-v2',
          legacy_misaligned_records: 17,
        },
        summary: {
          '012920': {
            model_version: 'active-v1', samples: 0, status: 'collecting', confidence: '样本积累中',
            mae: null, bias: null, direction_accuracy: null, error_band: null,
            legacy_misaligned: 5,
          },
        },
        records: [],
      }),
    }))
    await loadOverseasAccuracy(true)
    const estimate: Estimate = {
      code: '012920', name: '测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
      baseNav: 4, baseNavDate: '2026-08-11', valueNav: 4.1, valueDate: '2026-08-12',
      navDate: '2026-08-11', estTime: '2026-08-13 14:30',
      kind: 'overseas_model', label: '海外模型估算', isRealtime: true,
      sourceNote: '风格模型', modelWeight: 100, modelVersion: 'active-v1',
    }
    const result = await attachAccuracy(estimate)
    expect(result.accuracySamples).toBe(0)
    expect(result.confidence).toBe('精度样本重新积累中')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })
})

describe('overseas accuracy request recovery', () => {
  const report = {
    updated_at: '2026-07-10', summary: { '012920': {
      samples: 0, status: 'collecting', confidence: '样本积累中',
      mae: null, bias: null, direction_accuracy: null, error_band: null,
    } }, records: [],
  }
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it.each(['fetch', 'body'])('does not retain a failed %s promise forever', async phase => {
    const { loadOverseasAccuracy: load } = await import('./overseasAccuracy')
    const fetchMock = vi.fn().mockImplementationOnce(() => phase === 'fetch'
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(report) })
    vi.stubGlobal('fetch', fetchMock)
    const pending = load()
    await vi.advanceTimersByTimeAsync(12_001)
    expect(await pending).toBeNull()
    expect(await load()).toMatchObject({ summary: { '012920': { mae: null, error_band: null } } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed numeric metadata without poisoning a retry', async () => {
    const { loadOverseasAccuracy: load } = await import('./overseasAccuracy')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ...report, summary: { '012920': { ...report.summary['012920'], error_band: '0' } } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(report) })
    vi.stubGlobal('fetch', fetchMock)
    expect(await load()).toBeNull()
    expect(await load()).toMatchObject({ summary: { '012920': { error_band: null } } })
  })

  it('does not cancel another public report request when one caller aborts', async () => {
    const { loadOverseasAccuracy: load } = await import('./overseasAccuracy')
    let resolveDefault!: (value: unknown) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(resolve => { resolveDefault = resolve }) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const cancelled = load(false, { signal: controller.signal })
    const shared = load()
    expect(load()).toBe(shared)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await cancelled).toBeNull()
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false)
    resolveDefault(report)
    expect(await shared).toMatchObject({ updated_at: '2026-07-10' })
  })

  it('keeps a newer forced generation when an older request finishes later', async () => {
    const { loadOverseasAccuracy: load } = await import('./overseasAccuracy')
    let resolveOld!: (value: unknown) => void
    const newer = { ...report, updated_at: '2026-07-11' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(resolve => { resolveOld = resolve }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(newer) })
    vi.stubGlobal('fetch', fetchMock)
    const old = load()
    await vi.advanceTimersByTimeAsync(0)
    expect(await load(true)).toMatchObject({ updated_at: '2026-07-11' })
    resolveOld(report)
    await old
    expect(await load()).toMatchObject({ updated_at: '2026-07-11' })
    expect(fetchMock.mock.calls[1][1].cache).toBe('reload')
  })
})

describe('overseas accuracy per-model freshness regression', () => {
  const staleOwnRecord = {
    code: '018147', name: '公开测试QDII', status: 'settled', model_version: 'active-v1',
    prediction_date: '2026-10-16', target_nav_date: '2026-10-15', base_nav_date: '2026-10-14',
    observed_at: '2026-10-16T14:35:00+08:00', settled_at: '2026-10-16T19:50:55+08:00',
    alignment_version: 'observation-target-v2',
    predicted_change: 1, actual_change: 0.5, error: 0.5,
  }
  const freshOtherRecord = {
    ...staleOwnRecord, code: '012920', prediction_date: '2026-10-21',
    target_nav_date: '2026-10-20', base_nav_date: '2026-10-19',
    observed_at: '2026-10-21T14:35:00+08:00', settled_at: '2026-10-21T20:18:08+08:00',
  }
  const estimate: Estimate = {
    code: '018147', name: '公开测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
    baseNav: 4, baseNavDate: '2026-10-20', valueNav: 4.1, valueDate: '2026-10-21',
    navDate: '2026-10-20', estTime: '2026-10-22T10:00:00+08:00',
    kind: 'overseas_model', label: '海外模型估算', isRealtime: false,
    sourceNote: '公开测试风格模型', modelWeight: 100, modelVersion: 'active-v1',
  }

  async function attach(records: Record<string, unknown>[], options: {
    summary?: Record<string, unknown>; estimate?: Partial<Estimate>; globalSettlement?: string
  } = {}) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({
        updated_at: '2026-10-21T20:19:19+08:00',
        pipeline: { heartbeat_at: '2026-10-21T20:19:19+08:00',
          last_effective_settlement_at: options.globalSettlement ?? freshOtherRecord.settled_at },
        summary: { '018147': {
          model_version: 'active-v1', samples: 22, status: 'healthy', confidence: '较高',
          mae: 0.784, bias: -0.058, direction_accuracy: 81.8, error_band: 1.171,
          ...options.summary,
        } }, records,
      }),
    }))
    await loadOverseasAccuracy(true)
    return attachAccuracy({ ...estimate, ...options.estimate })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T02:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not let another fund settlement renew this fund precision metrics', async () => {
    const result = await attach([staleOwnRecord, freshOtherRecord])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBe(staleOwnRecord.settled_at)
  })

  it('does not let another model version renew the matching active version', async () => {
    const result = await attach([staleOwnRecord, { ...freshOtherRecord, code: '018147', model_version: 'other-v2' }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBe(staleOwnRecord.settled_at)
  })

  it('does not infer a missing per-model settlement time from a fresh global time', async () => {
    const { settled_at: _discarded, ...missingTime } = staleOwnRecord
    const result = await attach([missingTime, freshOtherRecord])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it('uses its own settlement even when the global time is old', async () => {
    const own = { ...freshOtherRecord, code: '018147' }
    const result = await attach([own], { globalSettlement: staleOwnRecord.settled_at })
    expect(result.confidence).toBe('较高')
    expect(result.accuracyUpdatedAt).toBe(own.settled_at)
    expect(result.sourceNote).toBe('公开测试风格模型 · 较高 · 历史约±1.17%')
  })

  it('does not use a fresh pending prediction to renew settled-error metrics', async () => {
    const result = await attach([staleOwnRecord, { ...freshOtherRecord, code: '018147', status: 'pending' }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBe(staleOwnRecord.settled_at)
  })

  it('treats an empty/windowed record population as unknown rather than inferring completeness', async () => {
    const result = await attach([])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it.each([
    ['missing estimate version', { estimate: { modelVersion: undefined } }],
    ['different estimate version', { estimate: { modelVersion: 'other-v2' } }],
    ['missing summary version', { summary: { model_version: undefined } }],
    ['different summary version', { summary: { model_version: 'other-v2' } }],
  ])('does not borrow samples or an error interval with %s', async (_name, options) => {
    const result = await attach([{ ...freshOtherRecord, code: '018147' }], options)
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracySamples).toBeUndefined()
    expect(result.errorBand).toBeUndefined()
    expect(result.accuracyUpdatedAt).toBeUndefined()
    expect(result.sourceNote).toBe('公开测试风格模型 · 精度数据过期')
  })

  it.each([
    ['exactly 96 hours', -96 * 60 * 60 * 1000, '较高', true],
    ['96 hours plus 1 ms', -96 * 60 * 60 * 1000 - 1, '精度数据过期', true],
    ['exactly 5 future minutes', 5 * 60 * 1000, '较高', true],
    ['5 future minutes plus 1 ms', 5 * 60 * 1000 + 1, '精度数据过期', false],
  ])('preserves the freshness boundary at %s', async (_name, delta, confidence, keepsTime) => {
    const time = new Date(Date.now() + delta).toISOString()
    const result = await attach([{ ...staleOwnRecord, settled_at: time }])
    expect(result.confidence).toBe(confidence)
    expect(result.accuracyUpdatedAt).toBe(keepsTime ? time : undefined)
  })

  it.each([
    ['empty', ''], ['unparseable', 'not-a-timestamp'], ['date only', '2026-10-21'],
    ['missing zone', '2026-10-21T20:18:08'], ['normalized invalid day', '2026-02-30T20:18:08+08:00'],
    ['normalized 24-hour time', '2026-10-21T24:00:00+08:00'],
    ['settled before observed', '2026-10-16T14:34:59+08:00'],
  ])('fails closed on %s settlement time', async (_name, settled_at) => {
    const result = await attach([{ ...staleOwnRecord, settled_at }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it.each([
    ['observed_only', { status: 'observed_only' }],
    ['quarantined legacy', { status: 'legacy_misaligned', excluded_from_metrics: true }],
    ['excluded settled', { excluded_from_metrics: true }],
    ['wrong observation calendar day', { prediction_date: '2026-10-20' }],
    ['missing alignment', { alignment_version: undefined }],
    ['missing observation time', { observed_at: undefined }],
    ['missing actual change', { actual_change: undefined }],
    ['missing error', { error: undefined }],
  ])('does not trust a fresh %s record', async (_name, change) => {
    const result = await attach([{ ...freshOtherRecord, code: '018147', ...change }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it('does not resolve conflicting duplicate identities by selecting the newest timestamp', async () => {
    const own = { ...freshOtherRecord, code: '018147' }
    const result = await attach([own, { ...own, settled_at: '2026-10-22T09:00:00+08:00' }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it('uses producer uniqueness even if a duplicate observation changes its target date', async () => {
    const own = { ...freshOtherRecord, code: '018147' }
    const result = await attach([own, { ...own, target_nav_date: '2026-10-19', base_nav_date: '2026-10-16' }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it('ignores explicitly excluded rows without poisoning eligible records of the same model', async () => {
    const result = await attach([staleOwnRecord, { ...freshOtherRecord, code: '018147', excluded_from_metrics: true }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBe(staleOwnRecord.settled_at)
    const own = { ...freshOtherRecord, code: '018147' }
    const fresh = await attach([own, { ...staleOwnRecord, excluded_from_metrics: true }])
    expect(fresh.confidence).toBe('较高')
    expect(fresh.accuracyUpdatedAt).toBe(own.settled_at)
  })

  it('compares timezone-aware times by instant rather than lexical order', async () => {
    const early = { ...staleOwnRecord, settled_at: '2026-10-21T23:00:00+08:00' }
    const later = { ...freshOtherRecord, code: '018147', settled_at: '2026-10-21T16:00:00Z' }
    const result = await attach([early, later])
    expect(result.confidence).toBe('较高')
    expect(result.accuracyUpdatedAt).toBe(later.settled_at)
  })

  it.each(['1', '123456', '123456789'])('accepts a bounded %s fractional timestamp without fabricating precision', async fraction => {
    const time = `2026-10-21T20:18:08.${fraction}+08:00`
    const result = await attach([{ ...freshOtherRecord, code: '018147', settled_at: time }])
    expect(result.confidence).toBe('较高')
    expect(result.accuracyUpdatedAt).toBe(time)
  })

  it('orders sub-millisecond timestamps and rejects a settlement even 1 ns before its observation', async () => {
    const early = { ...staleOwnRecord, settled_at: '2026-10-21T20:18:08.123456788+08:00' }
    const later = { ...freshOtherRecord, code: '018147', settled_at: '2026-10-21T20:18:08.123456789+08:00' }
    const result = await attach([early, later])
    expect(result.accuracyUpdatedAt).toBe(later.settled_at)
    const invalid = await attach([{ ...later, observed_at: later.settled_at, settled_at: early.settled_at }])
    expect(invalid.confidence).toBe('精度数据过期')
    expect(invalid.accuracyUpdatedAt).toBeUndefined()
  })

  it('does not clip +5min+1ns to an allowed future timestamp', async () => {
    const time = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('.000Z', '.000000001Z')
    const result = await attach([{ ...staleOwnRecord, settled_at: time }])
    expect(result.confidence).toBe('精度数据过期')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it.each([0, null])('preserves an explicit %s error interval and zero-valued finance fields', async error_band => {
    const result = await attach([{ ...freshOtherRecord, code: '018147', predicted_change: 0, actual_change: 0, error: 0 }], {
      summary: { error_band, mae: 0, bias: 0, direction_accuracy: 0 },
    })
    expect(result.confidence).toBe('较高')
    expect(result.errorBand).toBe(error_band)
    expect(result.accuracySamples).toBe(22)
    expect(result.sourceNote.includes('历史约±0.00%')).toBe(error_band === 0)
  })

  it('uses only a matching prediction observed_at for a zero-sample model', async () => {
    const own = { ...freshOtherRecord, code: '018147', status: 'pending' }
    const result = await attach([own, { ...freshOtherRecord, observed_at: '2026-10-21T23:59:00+08:00' }], {
      summary: { samples: 0, status: 'collecting', confidence: '样本积累中',
        mae: null, bias: null, direction_accuracy: null, error_band: null },
    })
    expect(result.confidence).toBe('精度样本重新积累中')
    expect(result.accuracySamples).toBe(0)
    expect(result.errorBand).toBeNull()
    expect(result.accuracyUpdatedAt).toBe(own.observed_at)
  })

  it('keeps zero-sample provenance unknown without its own matching prediction', async () => {
    const result = await attach([freshOtherRecord], {
      summary: { samples: 0, status: 'collecting', confidence: '样本积累中',
        mae: null, bias: null, direction_accuracy: null, error_band: null },
    })
    expect(result.confidence).toBe('精度样本重新积累中')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })

  it('resolves all three actual public artifact models from their own dated settled rows', async () => {
    // This is the repository's real public artifact, not a fabricated financial
    // date. Its producer timestamp makes this integration regression repeatable.
    vi.setSystemTime(new Date(currentOverseasLedger.updated_at))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(currentOverseasLedger) }))
    const report = await loadOverseasAccuracy(true)
    expect(report).not.toBeNull()
    for (const code of ['539002', '012920', '018147']) {
      const summary = report!.summary[code]!
      const records = report!.records.filter(row => row.code === code && row.model_version === summary.model_version
        && row.status === 'settled' && row.excluded_from_metrics !== true)
      expect(records.length).toBeGreaterThan(0)
      const latest = records.reduce((left, right) => Date.parse(left.settled_at!) > Date.parse(right.settled_at!) ? left : right)
      expect(accuracyEffectiveAt(report!, code, summary.model_version)).toBe(latest.settled_at)
      const result = await attachAccuracy({ ...estimate, code, modelVersion: summary.model_version })
      expect(result.accuracyUpdatedAt).toBe(latest.settled_at)
      expect(result.accuracySamples).toBe(summary.samples)
      expect(result.confidence).toBe(Date.now() - Date.parse(latest.settled_at!) > 96 * 60 * 60 * 1000
        ? '精度数据过期' : summary.confidence)
    }
  })
})
