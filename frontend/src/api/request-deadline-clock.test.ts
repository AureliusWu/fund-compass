/** The actual shared deadline, not a copied clock/budget implementation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withRequestDeadline } from './request'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function clock(initial = 100) {
  let value = initial
  const now = vi.fn(() => value)
  vi.stubGlobal('performance', { now })
  return { now, set(next: number) { value = next } }
}

describe('shared request deadline clock and budget guards', () => {
  it.each([NaN, Infinity, -Infinity])('rejects a non-finite start %s before starting work', async start => {
    const time = clock()
    // A finite second reading must not wash away the invalid captured start.
    time.now.mockReturnValueOnce(start)
    const operation = vi.fn(async () => 'must not start')
    await expect(withRequestDeadline(operation, undefined, 100)).rejects.toMatchObject({ kind: 'timeout' })
    expect(operation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects intermediate rollback even when every reading remains above the original start', async () => {
    const time = clock(), passedRollback = vi.fn()
    let active: AbortSignal | undefined
    await expect(withRequestDeadline(async (signal, check) => {
      active = signal
      time.set(110); check()
      time.set(109); check()
      passedRollback()
      return 'must not qualify'
    }, undefined, 100)).rejects.toMatchObject({ kind: 'timeout' })
    expect(passedRollback).not.toHaveBeenCalled()
    expect(active?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not heal an observed rollback after a later finite clock reading', async () => {
    const time = clock(), observed: string[] = []
    await expect(withRequestDeadline(async (_signal, check) => {
      time.set(110); check()
      time.set(109)
      try { check() } catch { observed.push('rollback rejected') }
      time.set(120)
      try { check() } catch { observed.push('recovered clock still rejected') }
      return 'late completion cannot heal the request'
    }, undefined, 100)).rejects.toMatchObject({ kind: 'timeout' })
    expect(observed).toEqual(['rollback rejected', 'recovered clock still rejected'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite progress %s and keeps the failure sticky', async bad => {
    const time = clock()
    await expect(withRequestDeadline(async (_signal, check) => {
      time.set(bad)
      expect(() => check()).toThrow()
      time.set(101)
      expect(() => check()).toThrow()
      return 'late completion'
    }, undefined, 100)).rejects.toMatchObject({ kind: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts equal finite readings and forward progress strictly inside the original budget', async () => {
    const time = clock()
    await expect(withRequestDeadline(async (_signal, check) => {
      check(); check()
      time.set(110); check(); check()
      time.set(199.999); check()
      return 'within one original deadline'
    }, undefined, 100)).resolves.toBe('within one original deadline')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires at exact elapsed equality rather than renewing the budget after progress', async () => {
    const time = clock()
    await expect(withRequestDeadline(async (_signal, check) => {
      time.set(150); check()
      time.set(200); check()
      return 'must not complete'
    }, undefined, 100)).rejects.toMatchObject({ kind: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([NaN, Infinity, -Infinity, 0, -1])('rejects an invalid timeout budget %s before starting work', async timeout => {
    clock()
    const operation = vi.fn(async () => 'must not start')
    await expect(withRequestDeadline(operation, undefined, timeout)).rejects.toMatchObject({ kind: 'timeout' })
    expect(operation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reject a finite positive fractional timeout solely because it is not an integer', async () => {
    const time = clock()
    await expect(withRequestDeadline(async (_signal, check) => {
      time.set(100.25); check()
      return 'valid fractional budget'
    }, undefined, 0.5)).resolves.toBe('valid fractional budget')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start work for an already cancelled caller', async () => {
    clock()
    const caller = new AbortController(), operation = vi.fn(async () => 'must not start')
    caller.abort('explicit cancellation')
    await expect(withRequestDeadline(operation, caller.signal, 100)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(operation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels pending work with an unchanged finite clock and rejects its late completion', async () => {
    clock()
    const caller = new AbortController()
    let finish!: (value: string) => void
    let active: AbortSignal | undefined
    const pending = withRequestDeadline(async (signal, check) => {
      active = signal
      const result = await new Promise<string>(resolve => { finish = resolve })
      check()
      return result
    }, caller.signal, 100)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    caller.abort('explicit cancellation')
    await assertion
    expect(active?.aborted).toBe(true)
    expect(active?.reason).toBe('explicit cancellation')
    finish('late result')
    await Promise.resolve()
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the independent timer bound if the finite monotonic clock stalls', async () => {
    clock()
    let finish!: (value: string) => void
    const pending = withRequestDeadline(async (_signal, check) => {
      const result = await new Promise<string>(resolve => { finish = resolve })
      check()
      return result
    }, undefined, 100)
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    finish('late result')
    await Promise.resolve()
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
