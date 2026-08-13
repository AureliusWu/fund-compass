import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accuracyEffectiveAt, attachAccuracy, loadOverseasAccuracy } from './overseasAccuracy'
import type { Estimate } from './estimate'

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
            samples: 24, status: 'healthy', confidence: '中等',
            mae: 1.2, bias: 0.1, direction_accuracy: 70, error_band: 1.8,
          },
        },
        records: [],
      }),
    }))
  })

  afterEach(() => vi.useRealTimers())

  it('attaches sample-backed confidence to a modeled estimate', async () => {
    await loadOverseasAccuracy(true)
    const estimate: Estimate = {
      code: '012920', name: '测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
      baseNav: 4, baseNavDate: '2026-07-09', valueNav: 4.1, valueDate: '2026-07-10',
      navDate: '2026-07-09', estTime: '2026-07-10 14:30',
      kind: 'overseas_model', label: '海外模型估算', isRealtime: true,
      sourceNote: '风格模型', modelWeight: 100,
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
            samples: 24, status: 'healthy', confidence: '中等',
            mae: 1.2, bias: 0.1, direction_accuracy: 70, error_band: 1.8,
          },
        },
        records: [],
      }),
    }))
    await loadOverseasAccuracy(true)
    const estimate: Estimate = {
      code: '012920', name: '测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
      baseNav: 4, baseNavDate: '2026-07-09', valueNav: 4.1, valueDate: '2026-07-10',
      navDate: '2026-07-09', estTime: '2026-07-10 14:30',
      kind: 'overseas_model', label: '海外模型估算', isRealtime: true,
      sourceNote: '风格模型', modelWeight: 100,
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
      summary: {}, records: [],
    }, 0)).toBe('2026-07-10T14:40:00+08:00')
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
            samples: 0, status: 'collecting', confidence: '样本积累中',
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
      sourceNote: '风格模型', modelWeight: 100,
    }
    const result = await attachAccuracy(estimate)
    expect(result.accuracySamples).toBe(0)
    expect(result.confidence).toBe('精度样本重新积累中')
    expect(result.accuracyUpdatedAt).toBeUndefined()
  })
})
