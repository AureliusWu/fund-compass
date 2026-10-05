import { describe, expect, it } from 'vitest'
import type { WatchEntry } from './gist'
import { aggregateFundHoldings } from './holding-aggregation'

const row = (account: string, extra: Partial<WatchEntry> = {}): WatchEntry => ({
  code: '000001', id: `000001::${account}`, account, name: '基金甲',
  shares: 100, cost: 1, target_weight: 10, position_kind: 'holding',
  updated_at: '2026-10-02T00:00:00Z', ...extra,
})

describe('fund-only confirmed-input aggregation', () => {
  it('sums accounts and share-weights complete unit costs without mutating entries', () => {
    const input = [row('甲'), row('乙', { shares: 50, cost: 2, target_weight: 30 })]
    const before = JSON.stringify(input)
    const result = aggregateFundHoldings(input)
    expect(result.complete).toBe(true)
    expect(result.funds[0]).toMatchObject({ shares: 150, costBasis: 200, cost: 200 / 150,
      targetWeight: 40, accountCount: 2, sharesComplete: true, costComplete: true, targetComplete: true })
    expect(JSON.stringify(input)).toBe(before)
  })
  it('never turns partial cost or target coverage into a complete fund value', () => {
    const result = aggregateFundHoldings([row('甲'), row('乙', { cost: null, target_weight: null })])
    expect(result.complete).toBe(true)
    expect(result.funds[0]).toMatchObject({ shares: 200, cost: null, costBasis: null,
      targetWeight: null, costComplete: false, targetComplete: false })
  })
  it('preserves real zero costs/targets and explicit zero-share holding records', () => {
    const result = aggregateFundHoldings([row('甲', { shares: 0, cost: 0, target_weight: 0 })])
    expect(result.complete).toBe(true)
    expect(result.funds[0]).toMatchObject({ shares: 0, costBasis: 0, cost: null, targetWeight: 0,
      costComplete: true, sharesComplete: true, targetComplete: true })
  })
  it('ignores tombstones and pure watch rows, but retains legacy positive positions', () => {
    const result = aggregateFundHoldings([row('甲', { position_kind: undefined }),
      row('乙', { shares: 0, position_kind: 'watch' }), row('丙', { deleted: true })])
    expect(result.funds).toHaveLength(1)
    expect(result.funds[0]).toMatchObject({ shares: 100, targetWeight: 10, accountCount: 1 })
  })
  it('does not infer missing shares with a supplied cost to mean no holding', () => {
    const result = aggregateFundHoldings([row('甲', { position_kind: undefined, shares: undefined })])
    expect(result.complete).toBe(false)
    expect(result.errors).toContain('unknown_position_kind')
  })
  it('retains unknown explicit holding shares and blocks a complete denominator', () => {
    const result = aggregateFundHoldings([row('甲', { shares: undefined })])
    expect(result.complete).toBe(false)
    expect(result.funds[0]).toMatchObject({ shares: null, sharesComplete: false, costBasis: null, costComplete: false })
  })
  it('does not select the last account or normalize total fund targets over 100%', () => {
    const result = aggregateFundHoldings([row('甲', { target_weight: 80 }), row('乙', { target_weight: 30 })])
    expect(result.complete).toBe(false)
    expect(result.errors).toContain('fund_target_weight_sum_invalid')
    expect(result.funds[0].targetWeight).toBeNull()
  })
  it.each([NaN, Infinity, -1, true, '100'])('rejects invalid shares %s without coercion', (shares) => {
    const result = aggregateFundHoldings([row('甲', { shares } as Partial<WatchEntry>)])
    expect(result.complete).toBe(false)
    expect(result.funds[0].shares).toBeNull()
  })
  it.each([NaN, Infinity, -1, true, '1'])('rejects invalid cost %s without coercion', (cost) => {
    const result = aggregateFundHoldings([row('甲', { cost } as Partial<WatchEntry>)])
    expect(result.complete).toBe(false)
    expect(result.funds[0].costBasis).toBeNull()
  })
  it.each([NaN, Infinity, -1, 101, true, '10'])('rejects invalid target %s without coercion', (target_weight) => {
    const result = aggregateFundHoldings([row('甲', { target_weight } as Partial<WatchEntry>)])
    expect(result.complete).toBe(false)
    expect(result.funds[0].targetWeight).toBeNull()
  })
  it('rejects duplicated normalized accounts and mismatched IDs', () => {
    expect(aggregateFundHoldings([row('甲'), row(' 甲 ', { id: '000001::甲' })]).complete).toBe(false)
    expect(aggregateFundHoldings([row('甲', { id: '000001::乙' })]).complete).toBe(false)
  })
  it('cannot silently ignore invalid identities or a positive position marked watch', () => {
    for (const entry of [row('甲', { code: 'bad' }), row('甲', { account: 1 } as unknown as Partial<WatchEntry>),
      row('甲', { position_kind: 'watch' }), row('甲', { position_kind: 'bad' } as unknown as Partial<WatchEntry>)]) {
      expect(aggregateFundHoldings([entry]).complete).toBe(false)
    }
  })
  it('rejects overflowing sums rather than showing Infinity', () => {
    const shares = aggregateFundHoldings([row('甲', { shares: 1e308 }), row('乙', { shares: 1e308 })])
    expect(shares.complete).toBe(false)
    expect(shares.funds[0].shares).toBeNull()
    const costs = aggregateFundHoldings([row('甲', { shares: 1e308, cost: 1e308 })])
    expect(costs.complete).toBe(false)
    expect(costs.funds[0].costBasis).toBeNull()
  })
})
