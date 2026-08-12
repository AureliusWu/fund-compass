import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('secondary model freshness guard', () => {
  it.each(['FundDetailPage.vue', 'ReportPage.vue'])(
    'routes the secondary model line in %s through preferredDailyMove',
    (file) => {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
      expect(source).toContain("est.value?.kind === 'overseas_model'")
      expect(source).toContain('preferredDailyMove(est.value, null')
      expect(source).toContain("primaryMove.value?.label === '净' && modelMove.value != null")
      expect(source).toContain('estimateDataFreshness')
      expect(source).toContain('const estimateExpired = computed(() =>')
      expect(source).toContain("estimateDataFreshness(est.value) === 'expired'")
      expect(source).toContain('估值数据过期')
      expect(source).toContain('· 已过期')
      expect(source).toContain('估值数据已过期，以最新正式净值为准')
    },
  )
})
