import { afterEach, describe, expect, it, vi } from 'vitest'
import * as ai from './ai'
import { compileStoryData, generateStorySummary, type StoryData } from './story'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('story free-text summary paused boundary', () => {
  it('rejects direct calls without a paid request, config access, or a disguised fallback', async () => {
    const fetch = vi.fn()
    const getItem = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('localStorage', { getItem })
    const chat = vi.spyOn(ai, 'chat')
    const data = compileStoryData({
      holdings: [], totalValue: 0, totalCost: 0, totalProfit: 0, totalRate: null, todayEst: null,
    })
    await expect(generateStorySummary(data)).rejects.toThrow(ai.FREE_TEXT_AI_UNAVAILABLE)
    expect(chat).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
  })

  it('fails closed before formatting even incomplete input', async () => {
    await expect(generateStorySummary({} as StoryData)).rejects.toThrow(ai.FREE_TEXT_AI_UNAVAILABLE)
  })
})
