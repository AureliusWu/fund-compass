/** Closed Owner policy timeline. Pure validation; no storage, HTTP or model-ID hashing. */
import type { V8PortfolioPolicy } from '@/api/client'
import { parseOwnerAnalysisJson, validateOwnerAnalysisPolicyValue } from './ownerAnalysisContract'

export const OWNER_POLICY_STATE_MAX_BYTES = 2 * 1024 * 1024
export const OWNER_POLICY_STATE_MAX_HISTORY = 1000
export interface OwnerPolicyState {
  readonly schema_version: 'owner-policy-state-1'
  readonly observed_at: string
  readonly current: V8PortfolioPolicy | null
  readonly next_effective_at: string | null
  readonly history: readonly V8PortfolioPolicy[]
}
export class OwnerPolicyStateError extends Error {
  readonly code = 'invalid_owner_policy_state'
  constructor() { super('Owner policy state rejected'); this.name = 'OwnerPolicyStateError' }
}
function reject(): never { throw new OwnerPolicyStateError() }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject()
  return value as Record<string, unknown>
}
/** UTC microseconds, never millisecond-rounded comparisons of policy order. */
function timestamp(value: unknown, utcOnly = false): bigint {
  if (typeof value !== 'string') reject()
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})(?![\s\S])/.exec(value)
  if (!match) return reject()
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  const y = +year, m = +month, d = +day
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || +hour > 23 || +minute > 59 || +second > 59
    || zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)
    || utcOnly && zone !== 'Z' && zone !== '+00:00') reject()
  const base = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`)
  if (!Number.isSafeInteger(base)) reject()
  return BigInt(base) * 1000n + BigInt((fraction || '').padEnd(6, '0'))
}
function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false
  const a = Object.keys(left).sort(), b = Object.keys(right).sort()
  return a.length === b.length && a.every((key, index) => key === b[index]
    && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
function policy(value: unknown, observed: bigint): { value: V8PortfolioPolicy; effective: bigint; created: bigint } {
  const row = object(value)
  const effective = timestamp(row.effective_at), created = timestamp(row.created_at)
  if (created > observed) reject()
  // Model validation must allow a legitimately scheduled future effective_at.
  // Round its validation ceiling up; all timeline decisions below remain exact.
  const maximum = effective > observed ? effective : observed
  const ceiling = Number(maximum >= 0n ? (maximum + 999n) / 1000n : maximum / 1000n)
  return { value: validateOwnerAnalysisPolicyValue(value, ceiling), effective, created }
}
/** Strictly validates the original raw envelope before materializing any Policy.
 * A valid timeline is a read snapshot, not proof that a strategy stays current. */
export function parseOwnerPolicyState(raw: string, nowMs = Date.now()): OwnerPolicyState {
  try {
    if (!Number.isSafeInteger(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) reject()
    const row = object(parseOwnerAnalysisJson(raw, OWNER_POLICY_STATE_MAX_BYTES))
    const fields = ['schema_version', 'observed_at', 'current', 'next_effective_at', 'history']
    if (Object.keys(row).length !== fields.length || fields.some(key => !Object.prototype.hasOwnProperty.call(row, key))
      || row.schema_version !== 'owner-policy-state-1' || !Array.isArray(row.history)
      || row.history.length > OWNER_POLICY_STATE_MAX_HISTORY) reject()
    const observed = timestamp(row.observed_at, true)
    if (observed > BigInt(nowMs) * 1000n) reject()
    const history = row.history.map(item => policy(item, observed))
    if (new Set(history.map(item => item.value.policy_version)).size !== history.length) reject()
    // A complete non-branching chain must be adjacent in strictly descending
    // effective order. Its earliest entry is the sole root, not a truncated page.
    history.forEach((item, index) => {
      const older = history[index + 1]
      if (!older) { if (item.value.supersedes !== null) reject() }
      else if (item.effective <= older.effective || item.created < older.created
        || item.value.supersedes !== older.value.policy_version) reject()
    })
    const selected = history.find(item => item.effective <= observed) ?? null
    let current: V8PortfolioPolicy | null = null
    if (row.current !== null) {
      const candidate = policy(row.current, observed)
      if (!selected || !same(candidate.value, selected.value)) reject()
      current = selected.value
    } else if (selected) reject()
    const upcoming = [...history].reverse().find(item => item.effective > observed) ?? null
    if (row.next_effective_at === null) { if (upcoming) reject() }
    else if (!upcoming || timestamp(row.next_effective_at, true) !== upcoming.effective) reject()
    return Object.freeze({ schema_version: 'owner-policy-state-1', observed_at: row.observed_at as string,
      current, next_effective_at: row.next_effective_at as string | null,
      history: Object.freeze(history.map(item => item.value)) })
  } catch { return reject() }
}
