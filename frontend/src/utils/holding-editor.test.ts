import { describe, expect, it } from 'vitest'
import { parseHoldingNumber, positionKind, validateHolding } from './holding-editor'

describe('holding draft contract', () => {
  it('separates empty unknowns and finite explicit zeros', () => {
    expect(parseHoldingNumber('')).toBeNull()
    expect(parseHoldingNumber(' 0 ')).toBe(0)
    expect(parseHoldingNumber('.25')).toBe(0.25)
    expect(() => parseHoldingNumber('', true)).toThrow()
  })
  it('never interprets a zero-share explicit holding as a watch entry', () => {
    expect(positionKind({ position_kind: 'holding', shares: 0 })).toBe('holding')
    expect(positionKind({ shares: 0 })).toBe('watch')
    expect(positionKind({ shares: 10 })).toBe('holding')
  })
  it('canonicalizes account identity but rejects watch entries with positive holdings', () => {
    expect(validateHolding({ code: '510300', account: ' 券商 ', position_kind: 'holding', shares: 0, cost: null, target_weight: 100 }).account).toBe('券商')
    expect(() => validateHolding({ code: '510300', account: '', position_kind: 'watch', shares: 1, cost: null, target_weight: null })).toThrow()
  })
})
