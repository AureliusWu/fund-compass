import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V8PortfolioPolicy } from '@/api/client'
import { parseOwnerAnalysisJson, parseOwnerAnalysisPolicy, validateOwnerAnalysisPolicyValue } from './ownerAnalysisContract'
import { parseOwnerPolicyState, OWNER_POLICY_STATE_MAX_BYTES, OwnerPolicyStateError, type OwnerPolicyState } from './ownerPolicyState'
import { ownerPolicyStateBackendWireFixture, ownerPolicyStateFixture, ownerPolicyStateRawFixture, OWNER_POLICY_STATE_FIXTURE_NOW as NOW } from './ownerPolicyState.fixtures'

type MutableState = Omit<{ -readonly [K in keyof OwnerPolicyState]: OwnerPolicyState[K] }, 'history'> & { history: V8PortfolioPolicy[] }
function state(): MutableState { const value = ownerPolicyStateFixture(); return { ...value, history: [...value.history] } }
function parse(input: unknown, now = NOW) { return parseOwnerPolicyState(JSON.stringify(input), now) }
function chain(): MutableState {
  const value = state(), root = value.current!
  const scheduled: V8PortfolioPolicy = { ...root, policy_version: 'pol_' + 'a'.repeat(64),
    supersedes: root.policy_version, name: 'Synthetic scheduled policy',
    effective_at: '2026-10-24T06:00:30.000123Z', created_at: '2026-10-24T05:00:00Z' }
  const later: V8PortfolioPolicy = { ...scheduled, policy_version: 'pol_' + 'b'.repeat(64),
    supersedes: scheduled.policy_version, effective_at: '2026-10-25T06:00:00Z', created_at: '2026-10-24T05:30:00Z' }
  return { ...value, next_effective_at: scheduled.effective_at, history: [later, scheduled, root] }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('closed Owner policy-state raw timeline', () => {
  it('accepts actual SQLite current/future wire without rewriting IDs, microseconds or null/zero fields', () => {
    const result = parseOwnerPolicyState(ownerPolicyStateBackendWireFixture(), Date.parse('2026-10-23T06:00:00.001Z'))
    expect(result.current!.policy_version).toBe('pol_ba6273f72b4664b6bd70538170d046d9f789b1ced02d45f6685a560024b2fbf8')
    expect(result.current!.rebalance_band).toBe(0)
    expect(result.current!.max_single_fund_weight).toBeNull()
    expect(result.current!.target_allocations['000001']).toBe(0)
    expect(result.history[0].target_allocations['000001']).toBe(25)
    expect(result.history[0].supersedes).toBe(result.current!.policy_version)
    expect(result.observed_at).toBe('2026-10-23T06:00:00.000001Z')
    expect(result.next_effective_at).toBe('2026-10-24T06:00:00.000001Z')
  })
  it('accepts the complete original backend Policy and freezes every returned reference', () => {
    const result = parseOwnerPolicyState(ownerPolicyStateRawFixture(), NOW)
    expect(result).toEqual(state())
    expect(result.current).toBe(result.history[0])
    for (const item of [result, result.history, result.current, result.current!.target_allocations, result.current!.dca_rules]) {
      expect(Object.isFrozen(item)).toBe(true)
    }
  })
  it('has no storage, network, session or cryptographic operation', () => {
    const io = vi.fn(() => { throw Error('unexpected private IO') })
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'crypto']) {
      vi.stubGlobal(name, new Proxy({}, { get: io }))
    }
    expect(parseOwnerPolicyState(ownerPolicyStateRawFixture(), NOW).current).not.toBeNull()
    expect(io).not.toHaveBeenCalled()
  })
  it('allows an explicitly empty history and an all-future first policy without creating a current policy', () => {
    const empty = { ...state(), current: null, history: [] }
    expect(parse(empty).current).toBeNull()
    const scheduled = { ...state().current!, effective_at: '2026-10-25T06:00:00Z' }
    const allFuture = { ...empty, history: [scheduled], next_effective_at: scheduled.effective_at }
    expect(parse(allFuture)).toEqual(allFuture)
  })
  it('accepts created future-effective successors and selects the nearest upcoming policy', () => {
    const input = chain(), result = parse(input)
    expect(result.current!.policy_version).toBe(input.current!.policy_version)
    expect(result.next_effective_at).toBe(input.history[1].effective_at)
    expect(result.history).toHaveLength(3)
    const boundary = { ...input, observed_at: '2026-10-24T06:00:30.000123Z', current: input.history[1],
      next_effective_at: input.history[0].effective_at }
    expect(parse(boundary, NOW + 30_001).current!.policy_version).toBe(input.history[1].policy_version)
  })
  it('compares actual UTC timestamps rather than lexical offset strings', () => {
    const input = chain()
    input.history[2] = { ...input.history[2], effective_at: '2026-10-23T14:07:29.561786+08:00' }
    input.history[1] = { ...input.history[1], effective_at: '2026-10-24T01:00:30.000123-05:00' }
    input.current = input.history[2]
    expect(parse(input).next_effective_at).toBe('2026-10-24T06:00:30.000123Z')
  })
  it('keeps microsecond ordering and exact current/next boundaries inside one JavaScript millisecond', () => {
    const input = chain()
    input.history = input.history.slice(1)
    input.history[1] = { ...input.history[1], effective_at: '2026-10-24T06:00:00.000001Z' }
    input.history[0] = { ...input.history[0], effective_at: '2026-10-24T06:00:00.000002Z' }
    input.current = input.history[1]; input.observed_at = input.current.effective_at
    input.next_effective_at = input.history[0].effective_at
    expect(parse(input, NOW + 1).current).toEqual(input.current)
    expect(() => parse({ ...input, current: input.history[0] }, NOW + 1)).toThrow(OwnerPolicyStateError)
    expect(() => parse({ ...input, next_effective_at: '2026-10-24T06:00:00.000003Z' }, NOW + 1)).toThrow(OwnerPolicyStateError)
    input.observed_at = input.history[0].effective_at; input.current = input.history[0]; input.next_effective_at = null
    expect(parse(input, NOW + 1).current).toEqual(input.history[0])
  })
  it('preserves legal floating number tokens and negative zero without a JSON reserialization', () => {
    const raw = ownerPolicyStateRawFixture().split('"dca_rules":{}').join(
      '"dca_rules":{"synthetic_large_float":1e16,"synthetic_float":1.0,"synthetic_zero":-0}')
    const result = parseOwnerPolicyState(raw, NOW)
    expect(result.current!.dca_rules.synthetic_large_float).toBe(1e16)
    expect(result.current!.dca_rules.synthetic_float).toBe(1)
    expect(Object.is(result.current!.dca_rules.synthetic_zero, -0)).toBe(true)
    expect(() => parseOwnerPolicyState(raw.split('1e16').join('10000000000000000'), NOW)).toThrow(OwnerPolicyStateError)
  })
  it('only shares Policy values actually produced by the bounded raw grammar', () => {
    const native = state().current!
    expect(() => validateOwnerAnalysisPolicyValue(native, NOW)).toThrow()
    const parsed = parseOwnerAnalysisJson(JSON.stringify(native), OWNER_POLICY_STATE_MAX_BYTES)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(validateOwnerAnalysisPolicyValue(parsed, NOW)).toEqual(native)
    expect(parseOwnerAnalysisPolicy(JSON.stringify(native), NOW)).toEqual(native)
    for (const bound of [0, -1, 1.5, NaN, Infinity, 2 * 1024 * 1024 + 4097]) {
      expect(() => parseOwnerAnalysisJson('{}', bound)).toThrow()
    }
  })
  it.each([
    (raw: string) => raw.replace('{', '{"schema_version":"owner-policy-state-1",'),
    (raw: string) => raw.replace('"current":{', '"current":{"name":"synthetic escaped duplicate",'),
    (raw: string) => raw.replace('"history":[{', '"history":[{"na\\u006de":"synthetic duplicate",'),
    (raw: string) => raw.replace('"dca_rules":{}', '"dca_rules":{"unsafe":9007199254740993}'),
    (raw: string) => raw.replace('"dca_rules":{}', '"dca_rules":{"nonfinite":1e309}'),
    (raw: string) => raw.replace('"dca_rules":{}', '"dca_rules":{"bad":"\\ud800"}'),
    (raw: string) => raw.replace('"dca_rules":{}', '"dca_rules":{"nested":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}'),
    (raw: string) => '\ufeff' + raw,
    (raw: string) => raw + '{}',
  ])('rejects malformed original JSON before any Policy can hide it (%#)', mutate => {
    expect(() => parseOwnerPolicyState(mutate(ownerPolicyStateRawFixture()), NOW)).toThrow(OwnerPolicyStateError)
  })
  it.each([
    { extra: 'synthetic private field' }, { schema_version: 'owner-policy-state-2' }, { history: null },
    { current: undefined }, { observed_at: undefined }, { history: {} }, { next_effective_at: 0 },
  ])('rejects aliases, missing and unexpected envelope fields: %j', change => {
    expect(() => parse({ ...state(), ...change })).toThrow(OwnerPolicyStateError)
  })
  it.each([
    '2026-02-30T00:00:00Z', '0000-10-24T06:00:00Z', '2026-10-24', '2026-10-24T06:00:00',
    '2026-10-24T06:00:60Z', '2026-10-24T24:00:00Z', '2026-10-24T06:00:00.0000001Z',
    '2026-10-24T14:00:00+08:00', '2026-10-24T06:00:00-00:00', '2026-10-24T06:00:00Z\n',
    '2026-10-24T06:00:00.000001Z',
  ])('rejects invalid, non-UTC or future observed_at %s', observed_at => {
    expect(() => parse({ ...state(), observed_at })).toThrow(OwnerPolicyStateError)
  })
  it('accepts zero-offset UTC aliases while preserving original wire strings', () => {
    const input = chain(); input.observed_at = '2026-10-24T06:00:00+00:00'
    input.next_effective_at = '2026-10-24T06:00:30.000123+00:00'
    expect(parse(input)).toEqual(input)
  })
  it.each([NaN, Infinity, -Infinity, NOW + .1, Number.MAX_SAFE_INTEGER])('rejects an invalid clock %s', now => {
    expect(() => parseOwnerPolicyState(ownerPolicyStateRawFixture(), now)).toThrow(OwnerPolicyStateError)
  })
  it.each(['created', 'bad-effective', 'unknown-field', 'bounded-allocation', 'wrong-id', 'wrong-rule'])(
    'validates every original Policy field (%s)', fault => {
      const input = state(), changed: Record<string, unknown> = { ...input.current! }
      if (fault === 'created') changed.created_at = '2026-10-24T06:00:00.000001Z'
      if (fault === 'bad-effective') changed.effective_at = '2026-02-30T00:00:00Z'
      if (fault === 'unknown-field') changed.secret = 'synthetic private field'
      if (fault === 'bounded-allocation') changed.target_allocations = { '510300': 101 }
      if (fault === 'wrong-id') changed.policy_version = 'pol_' + 'A'.repeat(64)
      if (fault === 'wrong-rule') changed.dca_rules = { max_step_percent: true }
      expect(() => parse({ ...input, current: changed, history: [changed] })).toThrow(OwnerPolicyStateError)
    },
  )
  it.each(['duplicate', 'fork', 'missing-parent', 'two-roots', 'cycle', 'wrong-order', 'same-effective', 'created-regression'])(
    'rejects incomplete, branched or temporally inconsistent history (%s)', fault => {
      const input = chain(), history = [...input.history]
      if (fault === 'duplicate') history[0] = history[1]
      if (fault === 'fork') history[0] = { ...history[0], supersedes: history[2].policy_version }
      if (fault === 'missing-parent') history.pop()
      if (fault === 'two-roots') history[1] = { ...history[1], supersedes: null }
      if (fault === 'cycle') history[2] = { ...history[2], supersedes: history[0].policy_version }
      if (fault === 'wrong-order') history.reverse()
      if (fault === 'same-effective') history[0] = { ...history[0], effective_at: history[1].effective_at }
      if (fault === 'created-regression') history[0] = { ...history[0], created_at: history[2].created_at }
      expect(() => parse({ ...input, history })).toThrow(OwnerPolicyStateError)
    },
  )
  it.each(['null-current', 'future-current', 'different-current', 'missing-next', 'later-next', 'past-next', 'nonutc-next', 'invented-next'])(
    'rejects a mismatched observed current or next transition (%s)', fault => {
      const input = chain()
      if (fault === 'null-current') input.current = null
      if (fault === 'future-current') input.current = input.history[1]
      if (fault === 'different-current') input.current = { ...input.current!, name: 'different synthetic policy' }
      if (fault === 'missing-next') input.next_effective_at = null
      if (fault === 'later-next') input.next_effective_at = input.history[0].effective_at
      if (fault === 'past-next') input.next_effective_at = input.current!.effective_at
      if (fault === 'nonutc-next') input.next_effective_at = '2026-10-24T14:00:30.000123+08:00'
      if (fault === 'invented-next') input.next_effective_at = '2026-10-24T06:00:31Z'
      expect(() => parse(input)).toThrow(OwnerPolicyStateError)
    },
  )
  it('enforces the complete 1000-entry limit rather than accepting a 1001-item page', () => {
    const input = state(), base = input.current!, start = Date.parse('2026-10-23T00:00:00Z')
    const history: V8PortfolioPolicy[] = []
    for (let index = 0; index < 1000; index++) history.unshift({ ...base,
      policy_version: 'pol_' + (index + 1).toString(16).padStart(64, '0'),
      supersedes: history[0]?.policy_version ?? null, effective_at: new Date(start + index).toISOString(),
      created_at: '2026-10-22T00:00:00Z' })
    const full = { ...input, current: history[0], history }
    expect(parse(full).history).toHaveLength(1000)
    expect(() => parse({ ...full, history: [...history, base] })).toThrow(OwnerPolicyStateError)
  })
  it('uses the UTF-8 2 MiB wire limit, with fixed errors that never echo private input', () => {
    const raw = ownerPolicyStateRawFixture()
    expect(parseOwnerPolicyState(raw + ' '.repeat(OWNER_POLICY_STATE_MAX_BYTES - raw.length), NOW).current).not.toBeNull()
    for (const large of [raw + ' '.repeat(OWNER_POLICY_STATE_MAX_BYTES - raw.length + 1),
      raw.replace('"dca_rules":{}', '"dca_rules":{"synthetic_secret":"' + '密'.repeat(OWNER_POLICY_STATE_MAX_BYTES / 2) + '"}')]) {
      try { parseOwnerPolicyState(large, NOW); throw Error('expected bounded rejection') }
      catch (error) { expect(error).toBeInstanceOf(OwnerPolicyStateError); expect(String(error)).toBe('OwnerPolicyStateError: Owner policy state rejected') }
    }
  })
})
