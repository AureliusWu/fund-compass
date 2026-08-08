import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('AssetsPage missing daily-move contract', () => {
  it('hides contribution rows when daily coverage is incomplete', () => {
    const source = readFileSync(new URL('./AssetsPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

    expect(source).toContain('v-if="!todayCoverage.complete" class="atr-note"')
    expect(source).toContain('贡献拆解已暂停，不以 0 补缺失值')
    expect(source).toContain('v-else-if="attrDim === \'account\'"')
    expect(source).toContain('v-if="todayCoverage.complete" class="atr-note"')
  })
})
