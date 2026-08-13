import { describe, expect, it } from 'vitest'

import { normalizeHoldingRow } from './holdings'

describe('normalizeHoldingRow', () => {
  it('keeps a valid disclosed ratio', () => {
    expect(normalizeHoldingRow('600000', '浦发银行', ' 3.25% ')).toEqual({
      code: '600000',
      name: '浦发银行',
      ratio: 3.25,
    })
  })

  it.each([undefined, null, '', '--', 'nan', 0, -1, 101])(
    'skips a holding when its ratio is missing or invalid: %s',
    (ratio) => {
      expect(normalizeHoldingRow('600000', '浦发银行', ratio)).toBeNull()
    },
  )
})
