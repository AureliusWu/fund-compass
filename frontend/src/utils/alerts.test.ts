import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkNavSpike, loadAlerts } from './alerts'

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
  it('creates only one alert for the same fund observation', async () => {
    installStorage()
    const estimate = {
      code: '005844', name: '测试基金', lastNav: 1, estNav: 0.94, estChange: -6.42,
      navDate: '2026-07-09', estTime: '2026-07-10 15:00', kind: 'intraday' as const,
      label: '盘中估值' as const, isRealtime: false, sourceNote: 'test',
    }

    expect(await checkNavSpike('005844', '测试基金', 3, estimate)).not.toBeNull()
    expect(await checkNavSpike('005844', '测试基金', 3, estimate)).toBeNull()
    expect(loadAlerts()).toHaveLength(1)
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
