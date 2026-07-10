import { beforeEach, describe, expect, it, vi } from 'vitest'

import { attachAccuracy, loadOverseasAccuracy } from './overseasAccuracy'
import type { Estimate } from './estimate'

describe('overseas accuracy metadata', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        updated_at: '2026-07-10',
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

  it('attaches sample-backed confidence to a modeled estimate', async () => {
    await loadOverseasAccuracy(true)
    const estimate: Estimate = {
      code: '012920', name: '测试QDII', lastNav: 4, estNav: 4.1, estChange: 2.5,
      navDate: '2026-07-09', estTime: '2026-07-10 14:30',
      kind: 'overseas_model', label: '海外模型估算', isRealtime: true,
      sourceNote: '风格模型', modelWeight: 100,
    }
    const result = await attachAccuracy(estimate)
    expect(result.confidence).toBe('中等')
    expect(result.accuracySamples).toBe(24)
    expect(result.errorBand).toBe(1.8)
    expect(result.sourceNote).toContain('历史约±1.80%')
  })
})
