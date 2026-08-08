import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('PortfolioLab detail loading', () => {
  it('uses the shared Pinia detail cache instead of bypassing it', () => {
    const source = readFileSync(new URL('./PortfolioLabPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

    expect(source).toContain("import { useFundsStore } from '@/stores/funds'")
    expect(source).toContain('const detail = await funds.detail(row.code)')
    expect(source).not.toContain('getFundDetail(row.code)')
  })
})
