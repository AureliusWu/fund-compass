import { afterEach, describe, expect, it, vi } from 'vitest'
import { alertFundTypeOrName, checkNavSpike, loadAlerts } from './alerts'
import { isOverseasLike } from './estimate'

const storage = new Map<string, string>()

afterEach(() => {
  storage.clear()
  vi.unstubAllGlobals()
})

function installStorage() {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
}

describe('holding alert deduplication', () => {
  it('uses the signal fund type before a non-matching display name', () => {
    const estimate = {
      code: '012920', name: '普通名称', lastNav: 5, estNav: 5.1, estChange: 2,
      navDate: '2026-07-09', estTime: '2026-07-10T07:00:00.000Z', kind: 'intraday' as const,
      label: '盘中估值' as const, isRealtime: true, sourceNote: 'test',
    }
    const typeOrName = alertFundTypeOrName('QDII', '普通名称', estimate)
    expect(typeOrName).toBe('QDII')
    expect(isOverseasLike(typeOrName, estimate)).toBe(true)
  })

  it('creates only one alert for the same fund observation', async () => {
    installStorage()
    const estimate = {
      code: '005844', name: '测试基金', lastNav: 1, estNav: 0.94, estChange: -6.42,
      navDate: '2026-07-09', estTime: '2026-07-10T07:00:00.000Z', kind: 'intraday' as const,
      label: '盘中估值' as const, isRealtime: false, sourceNote: 'test',
    }
    const observation = { estimate, now: Date.parse('2026-07-10T08:00:00.000Z') }

    expect(await checkNavSpike('005844', '测试基金', 3, observation)).not.toBeNull()
    expect(await checkNavSpike('005844', '测试基金', 3, observation)).toBeNull()
    expect(loadAlerts()).toHaveLength(1)
  })

  it('does not alert from an expired cached estimate', async () => {
    installStorage()
    const estimate = {
      code: '005844', name: '测试基金', lastNav: 1, estNav: 0.94, estChange: -6.42,
      navDate: '2026-07-01', estTime: '2026-07-01T07:00:00.000Z', kind: 'intraday' as const,
      label: '延迟估值' as const, isRealtime: false, sourceNote: 'test', cached: true,
      cachedAt: '2026-07-01T08:00:00.000Z',
    }

    expect(await checkNavSpike('005844', '测试基金', 3, {
      estimate,
      now: Date.parse('2026-07-10T08:00:00.000Z'),
    })).toBeNull()
    expect(loadAlerts()).toHaveLength(0)
  })

  it('labels QDII official NAV moves separately from next-NAV estimates', async () => {
    installStorage()
    const estimate = {
      code: '012920', name: '全球成长 QDII', lastNav: 5, estNav: 4.7, estChange: -6,
      navDate: '2026-07-09', estTime: '2026-07-10T07:00:00.000Z', kind: 'overseas_model' as const,
      label: '海外模型估算' as const, isRealtime: false, sourceNote: 'model',
      generatedAt: '2026-07-10T07:00:00.000Z',
    }
    const now = Date.parse('2026-07-10T08:00:00.000Z')
    const official = await checkNavSpike('012920', '全球成长', 3, {
      estimate,
      typeOrName: 'QDII',
      navMove: { date: '2026-07-10', prevDate: '2026-07-09', nav: 5.2, prevNav: 5, change: 4 },
      now,
    })
    const modeled = await checkNavSpike('012921', '海外基金', 3, {
      estimate: { ...estimate, code: '012921' },
      typeOrName: 'QDII',
      now,
    })

    expect(official).toMatchObject({
      title: '净值异动 · 全球成长',
      body: '最新公布净值涨 4.00%（2026-07-10）',
    })
    expect(modeled).toMatchObject({
      title: '估算异动 · 海外基金',
      body: '下一净值估算跌 6.00%（2026-07-10T07:00:00.000Z）',
    })
  })

  it('collapses duplicate records already stored by older versions', () => {
    installStorage()
    const base = {
      kind: 'nav_spike', code: '005844', name: '测试基金', level: 'danger',
      title: '异动 · 测试基金', body: '单日跌 6.42%（2026-07-10 15:00）',
      read: false, dismissed: false,
    }
    storage.set('sinan_alerts_v1', JSON.stringify([
      { ...base, id: 'old', time: '2026-07-11T03:08:45.000Z' },
      { ...base, id: 'new', time: '2026-07-11T03:11:17.000Z' },
    ]))

    expect(loadAlerts().map((alert) => alert.id)).toEqual(['new'])
    expect(JSON.parse(storage.get('sinan_alerts_v1') || '[]')).toHaveLength(1)
  })
})
