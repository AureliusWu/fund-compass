import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('operations worker degradation visibility', () => {
  it('renders the latest Worker warning with warning styling', () => {
    const source = readFileSync(new URL('./OperationsPage.vue', import.meta.url), 'utf8')
    expect(source).toContain('worker?.runtime?.last_warning')
    expect(source).toContain('class="warn-text"')
    expect(source).toContain('worker?.runtime?.decision_status')
  })
})
