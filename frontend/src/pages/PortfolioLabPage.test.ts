import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('PortfolioLab detail loading', () => {
  it('uses the shared Pinia detail cache instead of bypassing it', () => {
    const source = readFileSync(new URL('./PortfolioLabPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

    expect(source).toContain("import { useFundsStore } from '@/stores/funds'")
    expect(source).toContain('const detail = await funds.detail(row.code)')
    expect(source).not.toContain('getFundDetail(row.code)')
  })

  it('keeps missing target weights null and blocks incomplete or non-100 totals', () => {
    const source = readFileSync(new URL('./PortfolioLabPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

    expect(source).toContain('target: number | null')
    expect(source).toContain('target: row.target ?? null')
    expect(source).toContain('const targetReady = computed(() => targetTotal.value === 100)')
    expect(source).toContain('系统不会自动均分')
    expect(source).toContain('必须精确为 100.0%；系统不会自动归一化')
    expect(source).toContain(':disabled="!analysisReady"')
    expect(source).not.toContain('const fallback =')
    expect(source).not.toContain('row.target ?? fallback')
    expect(source).not.toContain('Number(item.target || 0)')
    expect(source).not.toContain('item.target = Number(item.target || 0) / totalTarget * 100')
  })
})
