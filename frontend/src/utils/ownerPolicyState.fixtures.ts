/** Actual backend Policy wrapped in a synthetic readonly timeline envelope.
 * Chain mutations in tests exercise reference validation, not Python ID hashes. */
import type { V8PortfolioPolicy } from '@/api/client'
import { ownerAnalysisBackendFixture } from './ownerAnalysisContract.fixtures'
import type { OwnerPolicyState } from './ownerPolicyState'

export const OWNER_POLICY_STATE_FIXTURE_NOW = Date.parse('2026-10-24T06:00:00Z')
export function ownerPolicyStateFixture(): OwnerPolicyState {
  const policy: V8PortfolioPolicy = JSON.parse(ownerAnalysisBackendFixture().policy)
  return { schema_version: 'owner-policy-state-1', observed_at: '2026-10-24T06:00:00Z',
    current: policy, next_effective_at: null, history: [policy] }
}
export function ownerPolicyStateRawFixture(): string { return JSON.stringify(ownerPolicyStateFixture()) }

/** Actual isolated SQLite builder/save_policy/read_owner_policy_state wire.
 * Captured with production repository scope; not remote or durability evidence. */
const backendWire = '{"current":{"created_at":"2026-10-23T06:00:00Z","dca_rules":{},"effective_at":"2026-10-23T06:00:00Z","max_single_fund_weight":null,"max_theme_weight":null,"name":"actual-current","policy_version":"pol_ba6273f72b4664b6bd70538170d046d9f789b1ced02d45f6685a560024b2fbf8","rebalance_band":0.0,"reduce_rules":{},"schema_version":"v8-policy-1","sell_rules":{},"source":"policy-wire-fixture","supersedes":null,"target_allocations":{"000001":0.0},"target_ranges":{}},"history":[{"created_at":"2026-10-23T06:00:00Z","dca_rules":{},"effective_at":"2026-10-24T06:00:00.000001Z","max_single_fund_weight":null,"max_theme_weight":null,"name":"actual-future","policy_version":"pol_1e3af5a485c5a15bfa6e9b75d7d99042bcf4b76771cd9f5ec89dd16f5815204f","rebalance_band":null,"reduce_rules":{},"schema_version":"v8-policy-1","sell_rules":{},"source":"policy-wire-fixture","supersedes":"pol_ba6273f72b4664b6bd70538170d046d9f789b1ced02d45f6685a560024b2fbf8","target_allocations":{"000001":25.0},"target_ranges":{}},{"created_at":"2026-10-23T06:00:00Z","dca_rules":{},"effective_at":"2026-10-23T06:00:00Z","max_single_fund_weight":null,"max_theme_weight":null,"name":"actual-current","policy_version":"pol_ba6273f72b4664b6bd70538170d046d9f789b1ced02d45f6685a560024b2fbf8","rebalance_band":0.0,"reduce_rules":{},"schema_version":"v8-policy-1","sell_rules":{},"source":"policy-wire-fixture","supersedes":null,"target_allocations":{"000001":0.0},"target_ranges":{}}],"next_effective_at":"2026-10-24T06:00:00.000001Z","observed_at":"2026-10-23T06:00:00.000001Z","schema_version":"owner-policy-state-1"}'
export function ownerPolicyStateBackendWireFixture(): string { return backendWire }
