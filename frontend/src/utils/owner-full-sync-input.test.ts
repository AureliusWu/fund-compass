import { describe, expect, it, vi } from 'vitest'
import { copyOwnerFullSyncInput, OwnerFullSyncInputError } from './owner-full-sync-input'
import { OWNER_WORKSPACE_BACKUP_MAX_BYTES } from './owner-workspace-backup'

describe('full-operation own input before async work', () => {
  it('owns and deeply freezes native values without losing negative zero or retaining mutable aliases', () => {
    const original = { nested: [{ amount: -0, missing: null }], raw: 'opaque original' }
    const checked = copyOwnerFullSyncInput(original) as typeof original
    expect(checked).not.toBe(original); expect(checked.nested).not.toBe(original.nested)
    expect(Object.is(checked.nested[0].amount, -0)).toBe(true)
    expect(Object.isFrozen(checked)).toBe(true); expect(Object.isFrozen(checked.nested)).toBe(true)
    expect(Object.isFrozen(checked.nested[0])).toBe(true)
    original.nested[0].amount = 7
    expect(Object.is(checked.nested[0].amount, -0)).toBe(true)
  })
  it('rejects accessors, hidden fields, symbols and sparse/augmented arrays without executing a getter', () => {
    const getter = vi.fn(), accessor = Object.defineProperty({}, 'private', { enumerable: true, get: getter })
    const augmented: unknown[] = []; Object.defineProperty(augmented, 'hidden', { value: 1 })
    for (const value of [accessor, Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('private')]: 1 }, new Array(1), augmented]) {
      expect(() => copyOwnerFullSyncInput(value)).toThrowError(OwnerFullSyncInputError)
    }
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([Number.NaN, Infinity, -Infinity, undefined, new Date(), '\ud800', '\udfff'])('rejects non-native scalar %s', value => {
    expect(() => copyOwnerFullSyncInput({ value })).toThrowError(OwnerFullSyncInputError)
  })
  it('applies the original complete UTF-8 operation budget, not merely character count', () => {
    const value = '中'.repeat(OWNER_WORKSPACE_BACKUP_MAX_BYTES / 3)
    expect(() => copyOwnerFullSyncInput(value)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded' }))
  })
  it('bounds cyclic or over-deep input instead of recursing indefinitely', () => {
    const cycle: { self?: unknown } = {}; cycle.self = cycle
    expect(() => copyOwnerFullSyncInput(cycle)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded' }))
  })
})
