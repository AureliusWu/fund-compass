import { describe, expect, it } from 'vitest'
import type { V8PortfolioPolicy } from '@/api/client'
import { ownerAnalysisBackendFixture } from './ownerAnalysisContract.fixtures'
import { ownerPolicyDiff, ownerPolicyValue } from './ownerPolicyDiff'

const policy = (): V8PortfolioPolicy => JSON.parse(ownerAnalysisBackendFixture().policy)
describe('read-only Policy business comparison', () => {
  it('does not create a difference from object property order', () => {
    const before = { ...policy(), target_allocations: { '000001': 20, '000002': 0 } }
    expect(ownerPolicyDiff(before, { ...before, target_allocations: { '000002': 0, '000001': 20 } })).toEqual([])
  })
  it('keeps null, actual zero and negative zero distinct without modifying models', () => {
    const before = { ...policy(), rebalance_band: null }, after = { ...before, rebalance_band: 0 }
    expect(ownerPolicyDiff(before, after)).toEqual([{ key: 'rebalance_band', label: '再平衡带（%）', before: '未设置（null）', after: '0' }])
    expect(ownerPolicyDiff(after, { ...after, rebalance_band: -0 })[0].after).toBe('-0')
    expect(before.rebalance_band).toBeNull(); expect(Object.is(after.rebalance_band, 0)).toBe(true)
  })
  it('shows all real nested rule changes, not merely a changed ID', () => {
    const before = { ...policy(), max_theme_weight: 50 }, after = { ...before, dca_rules: { minimum_confidence: 0 }, max_theme_weight: null }
    const rows = ownerPolicyDiff(before, after)
    expect(rows.find(row => row.key === 'dca_rules')?.after).toBe('{"minimum_confidence":0}')
    expect(rows.find(row => row.key === 'max_theme_weight')?.after).toBe('未设置（null）')
  })
  it('does not call model IDs, creation times, or selected policies action changes', () => {
    const before = policy()
    expect(ownerPolicyDiff(before, { ...before, policy_version: 'pol_' + 'a'.repeat(64), created_at: '2026-10-24T00:00:00Z' })).toEqual([])
  })
  it('preserves finite numeric detail in a pure display value', () => {
    expect(ownerPolicyValue({ target: null, amount: -0, value: 1e16 })).toBe('{"amount":-0,"target":null,"value":10000000000000000}')
  })
})
