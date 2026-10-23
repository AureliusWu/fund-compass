/** Closed raw Owner analysis contracts. No network, session or storage access. */
import type {
  V8DecisionSnapshot, V8EvidenceSnapshot, V8HoldingVersion, V8PortfolioPolicy,
} from '../api/client'

export const OWNER_ANALYSIS_MAX_BODY_BYTES = 16 * 1024
export const OWNER_ANALYSIS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 + 4096
const CODE = /^[0-9]{6}(?![\s\S])/
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const ids = {
  ev: /^ev_[0-9a-f]{64}(?![\s\S])/,
  pol: /^pol_[0-9a-f]{64}(?![\s\S])/,
  hold: /^hold_[0-9a-f]{64}(?![\s\S])/,
  dec: /^dec_[0-9a-f]{64}(?![\s\S])/,
  owner_analysis: /^owner_analysis_[0-9a-f]{64}(?![\s\S])/,
} as const

export interface OwnerAnalysisRequest {
  readonly request_id: string
  readonly expected_revision: number
  readonly policy_version: string
  readonly evidence: readonly { readonly code: string; readonly evidence_id: string }[]
}
export type OwnerAnalysisRequestInput = OwnerAnalysisRequest
export interface BuiltOwnerAnalysisRequest {
  readonly request: OwnerAnalysisRequest
  readonly rawBody: string
  readonly requestHash: string
  readonly byteLength: number
}
export interface OwnerAnalysisComponent {
  readonly code: string
  readonly account_count: number
  readonly holding: V8HoldingVersion
  readonly evidence: V8EvidenceSnapshot
  readonly decision: V8DecisionSnapshot
}
export interface OwnerAnalysisRun {
  readonly schema: 'owner-analysis-run-1'
  readonly request_id: string
  readonly request_hash: string
  readonly run_id: string
  readonly source: { readonly revision: number; readonly sha256: string; readonly record_count: number; readonly scope: 'fund_only' }
  readonly policy: V8PortfolioPolicy
  readonly strategy_version: string
  readonly created_at: string
  readonly pricing_complete: boolean
  readonly unavailable_codes: readonly string[]
  readonly components: readonly OwnerAnalysisComponent[]
}
export interface OwnerAnalysisResult {
  readonly run: OwnerAnalysisRun
  /** Only the server's source read snapshot; never an action/freshness qualification. */
  readonly source_current: boolean
}
export interface OwnerAnalysisFailure {
  readonly kind: 'failure'
  readonly status: number
  readonly code: string
}
export type OwnerAnalysisWriteResponse =
  | { readonly kind: 'success'; readonly status: 200; readonly result: OwnerAnalysisResult }
  | OwnerAnalysisFailure
export type OwnerAnalysisReceiptResponse =
  | { readonly state: 'matched'; readonly status: 200; readonly result: OwnerAnalysisResult }
  | { readonly state: 'unknown'; readonly status: 404 | 503; readonly error: 'analysis_result_unknown' }
  | OwnerAnalysisFailure

export class OwnerAnalysisContractError extends Error {
  constructor(readonly code: 'invalid_analysis_contract' | 'invalid_analysis_request' | 'invalid_analysis_restore' | 'analysis_hash_unavailable' = 'invalid_analysis_contract') {
    super('Owner analysis contract rejected')
    this.name = 'OwnerAnalysisContractError'
  }
}
function reject(): never { throw new OwnerAnalysisContractError() }
function scalar(value: unknown): asserts value is string {
  if (typeof value !== 'string') reject()
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject()
    } else if (unit >= 0xdc00 && unit <= 0xdfff) reject()
  }
}
function text(value: unknown, maximum: number, minimum = 0): string {
  scalar(value)
  if (value.length > maximum * 2) reject()
  const length = [...value].length
  if (length < minimum || length > maximum) reject()
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) reject()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) reject()
  return value as Record<string, unknown>
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const row = object(value), keys = Object.keys(row)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) reject()
  return row
}
function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum
      || Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length
      || Reflect.ownKeys(value).length !== value.length + 1
      || Object.keys(value).some((key, index) => key !== String(index))
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !('value' in item))) reject()
  return value
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
class JsonNumber {
  constructor(readonly value: number, readonly integerToken: boolean) {}
}
function number(value: unknown, low = -Infinity, high = Infinity, integer = false): number {
  if (value instanceof JsonNumber) {
    if (integer && !value.integerToken) reject()
    value = value.value
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high
      || (integer && !Number.isSafeInteger(value))) reject()
  return value
}
function integer(value: unknown, low = 0, high = Number.MAX_SAFE_INTEGER): number { return number(value, low, high, true) }
function nullableNumber(value: unknown, low = -Infinity, high = Infinity): number | null {
  return value === null ? null : number(value, low, high)
}
function nullableText(value: unknown, maximum: number): void { if (value !== null) text(value, maximum) }
function bool(value: unknown): asserts value is boolean { if (typeof value !== 'boolean') reject() }
function oneOf(value: unknown, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) reject()
}
function id(value: unknown, prefix: keyof typeof ids): string {
  if (typeof value !== 'string' || !ids[prefix].test(value)) reject()
  return value
}
function code(value: unknown): string { if (typeof value !== 'string' || !CODE.test(value)) reject(); return value }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) reject(); return value }
function strings(value: unknown, maximum: number, minimum = 0): string[] {
  return list(value, maximum, minimum).map(item => text(item, OWNER_ANALYSIS_MAX_RESPONSE_BYTES))
}
function bytes(raw: unknown, maximum: number): Uint8Array {
  if (typeof raw !== 'string' || raw.length > maximum) reject()
  scalar(raw)
  const encoded = new TextEncoder().encode(raw)
  if (encoded.byteLength > maximum) reject()
  return encoded
}

/** Complete bounded JSON grammar; number tokens remain distinct until validation. */
function parse(raw: unknown, maximum: number): unknown {
  bytes(raw, maximum)
  const source = raw as string
  let index = 0, nodes = 0
  const numeric = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
  function whitespace() { while (index < source.length && /[ \t\r\n]/.test(source[index])) index++ }
  function string(): string {
    const start = index++
    while (index < source.length) {
      const char = source[index++]
      if (char === '"') {
        let value: unknown
        try { value = JSON.parse(source.slice(start, index)) } catch { return reject() }
        scalar(value)
        return value
      }
      if (char.charCodeAt(0) < 32) reject()
      if (char === '\\') {
        const escape = source[index++]
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index, index + 4))) reject()
          index += 4
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) reject()
      }
    }
    return reject()
  }
  function value(depth: number): unknown {
    if (depth > 16 || ++nodes > 250_000) reject()
    whitespace()
    const char = source[index]
    if (char === '"') return string()
    if (char === '{') {
      index++; whitespace()
      const out: Record<string, unknown> = Object.create(null)
      if (source[index] === '}') { index++; return out }
      while (index < source.length) {
        if (source[index] !== '"') reject()
        const key = string()
        if (Object.prototype.hasOwnProperty.call(out, key)) reject()
        whitespace(); if (source[index++] !== ':') reject()
        out[key] = value(depth + 1); whitespace()
        const end = source[index++]
        if (end === '}') return out
        if (end !== ',') reject()
        whitespace()
      }
      return reject()
    }
    if (char === '[') {
      index++; whitespace()
      const out: unknown[] = []
      if (source[index] === ']') { index++; return out }
      while (index < source.length) {
        out.push(value(depth + 1)); whitespace()
        const end = source[index++]
        if (end === ']') return out
        if (end !== ',') reject()
      }
      return reject()
    }
    for (const [token, decoded] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, index)) { index += token.length; return decoded }
    }
    numeric.lastIndex = index
    const match = numeric.exec(source)
    if (!match) return reject()
    index = numeric.lastIndex
    const token = match[0], decoded = Number(token), integerToken = !/[.eE]/.test(token)
    if (!Number.isFinite(decoded) || (integerToken && !Number.isSafeInteger(decoded))) reject()
    return new JsonNumber(decoded, integerToken)
  }
  const result = value(1)
  whitespace(); if (index !== source.length) reject()
  return result
}
function materialize(value: unknown): unknown {
  if (value instanceof JsonNumber) return value.value
  if (Array.isArray(value)) return value.map(materialize)
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null)
    for (const [key, child] of Object.entries(value)) result[key] = materialize(child)
    return result
  }
  return value
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}
async function digest(value: Uint8Array): Promise<string> {
  try {
    const result = await globalThis.crypto.subtle.digest('SHA-256', value)
    return [...new Uint8Array(result)].map(item => item.toString(16).padStart(2, '0')).join('')
  } catch { throw new OwnerAnalysisContractError('analysis_hash_unavailable') }
}
function validateRequest(value: unknown): OwnerAnalysisRequest {
  const row = closed(value, ['request_id', 'expected_revision', 'policy_version', 'evidence'])
  if (typeof row.request_id !== 'string' || !REQUEST_ID.test(row.request_id)) reject()
  const evidence = list(row.evidence, 100, 1).map(item => {
    const reference = closed(item, ['code', 'evidence_id'])
    return { code: code(reference.code), evidence_id: id(reference.evidence_id, 'ev') }
  }).sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  if (new Set(evidence.map(item => item.code)).size !== evidence.length) reject()
  return frozen({ request_id: row.request_id, expected_revision: integer(row.expected_revision),
    policy_version: id(row.policy_version, 'pol'), evidence })
}
export async function buildOwnerAnalysisRequest(input: unknown): Promise<BuiltOwnerAnalysisRequest> {
  let request: OwnerAnalysisRequest, rawBody: string, encoded: Uint8Array
  try {
    request = validateRequest(input); rawBody = canonical(request)
    encoded = bytes(rawBody, OWNER_ANALYSIS_MAX_BODY_BYTES)
  } catch { throw new OwnerAnalysisContractError('invalid_analysis_request') }
  return frozen({ request, rawBody, requestHash: await digest(encoded), byteLength: encoded.byteLength })
}
export async function restoreOwnerAnalysisRequest(rawBody: string, expectedHash: string): Promise<BuiltOwnerAnalysisRequest> {
  let request: OwnerAnalysisRequest, encoded: Uint8Array
  try {
    hash(expectedHash); encoded = bytes(rawBody, OWNER_ANALYSIS_MAX_BODY_BYTES)
    request = validateRequest(parse(rawBody, OWNER_ANALYSIS_MAX_BODY_BYTES))
    if (canonical(request) !== rawBody) reject()
  } catch { throw new OwnerAnalysisContractError('invalid_analysis_restore') }
  const requestHash = await digest(encoded)
  if (requestHash !== expectedHash) throw new OwnerAnalysisContractError('invalid_analysis_restore')
  return frozen({ request, rawBody, requestHash, byteLength: encoded.byteLength })
}
function packetRequest(packet: BuiltOwnerAnalysisRequest): OwnerAnalysisRequest {
  // Hash provenance comes from build/restore, under the caller's original
  // operation budget. This synchronous parser binds that packet, and does not
  // authenticate the remote source or recompute Python's financial model IDs.
  const row = closed(packet, ['request', 'rawBody', 'requestHash', 'byteLength'])
  const request = validateRequest(row.request)
  if (canonical(request) !== row.rawBody || bytes(row.rawBody, OWNER_ANALYSIS_MAX_BODY_BYTES).byteLength !== integer(row.byteLength)) reject()
  hash(row.requestHash)
  return request
}

function day(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/.test(value)) reject()
  const [year, month, date] = value.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || date < 1 || date > days[month - 1]) reject()
  return value
}
function timestamp(value: unknown, maximum: bigint): bigint {
  if (typeof value !== 'string') reject()
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})(?![\s\S])/.exec(value)
  if (!match) return reject()
  day(match[1])
  if (+match[2] > 23 || +match[3] > 59 || +match[4] > 59) reject()
  if (match[6] !== 'Z' && (+match[6].slice(1, 3) > 23 || +match[6].slice(4) > 59)) reject()
  const base = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[6]}`)
  if (!Number.isSafeInteger(base)) reject()
  const result = BigInt(base) * 1000n + BigInt((match[5] || '').padEnd(6, '0'))
  if (result > maximum) reject()
  return result
}
function clock(nowMs: number): bigint {
  if (!Number.isSafeInteger(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) reject()
  return BigInt(nowMs) * 1000n
}
function marketDay(stamp: bigint): string { return new Date(Number(stamp / 1000n) + 8 * 3600_000).toISOString().slice(0, 10) }
function nodes(value: unknown): void {
  for (const item of list(value, 40)) {
    const row = closed(item, ['node_id', 'category', 'state', 'label', 'value', 'source_id'])
    text(row.node_id, 80, 1); text(row.label, 240, 1); nullableText(row.source_id, 120)
    oneOf(row.category, ['valuation', 'trend', 'momentum', 'quality', 'risk', 'holding', 'portfolio', 'data_quality', 'model_accuracy', 'outcome'])
    oneOf(row.state, ['support', 'constraint', 'neutral', 'missing'])
    if (row.value !== null && typeof row.value !== 'string' && typeof row.value !== 'boolean') number(row.value)
  }
}
const EVIDENCE_FIELDS = ['schema_version', 'evidence_id', 'fund_code', 'fund_name', 'fund_type', 'created_at', 'market_time', 'official_nav', 'official_nav_date', 'target_nav_date', 'benchmark_id', 'valuation_percentile', 'trend_state', 'momentum_state', 'drawdown', 'volatility', 'market_temperature', 'score', 'score_version', 'score_coverage', 'timing_signal', 'timing_coverage', 'estimate', 'estimate_status', 'estimate_coverage', 'estimate_model_version', 'estimate_error_p80', 'estimate_sample_count', 'estimate_mae', 'estimate_direction_accuracy', 'source_states', 'evidence_nodes', 'evidence_strength', 'missing_fields', 'stale_fields', 'risk_flags'] as const
function evidence(value: unknown, expectedCode: string, maximum: bigint): Record<string, unknown> {
  const row = closed(value, EVIDENCE_FIELDS)
  if (row.schema_version !== 'v8-evidence-1' || code(row.fund_code) !== expectedCode) reject()
  id(row.evidence_id, 'ev'); nullableText(row.fund_name, 200); text(row.fund_type, 120, 1)
  const created = timestamp(row.created_at, maximum)
  if (row.market_time !== null) timestamp(row.market_time, created)
  const nav = nullableNumber(row.official_nav, 0)
  if ((nav === null) !== (row.official_nav_date === null) || nav === 0) reject()
  if (row.official_nav_date !== null && day(row.official_nav_date) > marketDay(maximum)) reject()
  if (row.target_nav_date !== null && (row.official_nav_date === null
      || day(row.target_nav_date) <= day(row.official_nav_date) || row.estimate === null)) reject()
  for (const field of ['benchmark_id', 'trend_state', 'momentum_state', 'score_version', 'estimate_model_version']) nullableText(row[field], 120)
  nullableText(row.timing_signal, 80)
  for (const field of ['valuation_percentile', 'market_temperature', 'score', 'estimate_coverage', 'estimate_direction_accuracy']) nullableNumber(row[field], 0, 100)
  for (const field of ['volatility', 'estimate_error_p80', 'estimate_mae']) nullableNumber(row[field], 0)
  nullableNumber(row.drawdown); nullableNumber(row.estimate, -100, 1000)
  if (row.estimate_sample_count !== null) integer(row.estimate_sample_count)
  number(row.score_coverage, 0, 1); number(row.timing_coverage, 0, 1)
  number(row.evidence_strength, 0, 100); text(row.estimate_status, 80, 1)
  for (const item of list(row.source_states, 30)) {
    const state = closed(item, ['source_id', 'state', 'last_success', 'last_failure', 'latency_ms', 'data_age_seconds', 'stale', 'error_class'])
    text(state.source_id, 120, 1); nullableText(state.error_class, 120); bool(state.stale)
    oneOf(state.state, ['healthy', 'degraded', 'stale', 'unavailable', 'unknown'])
    for (const field of ['last_success', 'last_failure']) if (state[field] !== null) timestamp(state[field], maximum)
    nullableNumber(state.latency_ms, 0); nullableNumber(state.data_age_seconds, 0)
  }
  nodes(row.evidence_nodes)
  for (const field of ['missing_fields', 'stale_fields', 'risk_flags']) strings(row[field], 50)
  return row
}
function pair(value: unknown, low = 0, high = 100): void {
  if (value === null) return
  const range = list(value, 2, 2)
  if (number(range[0], low, high) > number(range[1], low, high)) reject()
}
function policy(value: unknown, maximum: bigint): Record<string, unknown> {
  const row = closed(value, ['schema_version', 'policy_version', 'name', 'target_allocations', 'target_ranges', 'max_single_fund_weight', 'max_theme_weight', 'rebalance_band', 'dca_rules', 'reduce_rules', 'sell_rules', 'effective_at', 'created_at', 'source', 'supersedes'])
  if (row.schema_version !== 'v8-policy-1') reject()
  id(row.policy_version, 'pol'); text(row.name, 120, 1); text(row.source, 120, 1)
  if (row.supersedes !== null) id(row.supersedes, 'pol')
  timestamp(row.effective_at, maximum); timestamp(row.created_at, maximum)
  const allocations = object(row.target_allocations), ranges = object(row.target_ranges)
  if (Object.keys(allocations).length > 100 || Object.keys(ranges).length > 100) reject()
  let total = 0
  for (const [key, value] of Object.entries(allocations)) {
    scalar(key); if (!key.trim()) reject(); total += number(value, 0, 100)
  }
  if (total > 100 + 1e-9) reject()
  for (const [key, value] of Object.entries(ranges)) { scalar(key); if (!key.trim() || value === null) reject(); pair(value) }
  for (const field of ['max_single_fund_weight', 'max_theme_weight']) if (row[field] !== null && number(row[field], 0, 100) === 0) reject()
  nullableNumber(row.rebalance_band, 0, 50)
  for (const field of ['dca_rules', 'reduce_rules', 'sell_rules']) if (Object.keys(object(row[field])).length > 30) reject()
  for (const field of ['dca_rules', 'reduce_rules']) {
    const rules = object(row[field])
    if (rules.max_step_percent !== undefined && rules.max_step_percent !== null && number(rules.max_step_percent, 0, 100) === 0) reject()
  }
  const dca = object(row.dca_rules), sell = object(row.sell_rules)
  if (dca.minimum_confidence !== undefined && dca.minimum_confidence !== null) number(dca.minimum_confidence, 0, 100)
  if (sell.require_structural_invalidation !== undefined && sell.require_structural_invalidation !== null) bool(sell.require_structural_invalidation)
  return row
}
function holding(value: unknown, expectedCode: string, runId: string, stamp: bigint, accountCount: number): Record<string, unknown> {
  const row = closed(value, ['schema_version', 'holding_version', 'fund_code', 'user_state', 'shares', 'cost', 'market_value', 'account', 'current_weight', 'target_weight', 'updated_at', 'source', 'created_at'])
  if (row.schema_version !== 'v8-holding-1' || code(row.fund_code) !== expectedCode
      || row.user_state !== (accountCount ? 'held' : 'unheld') || row.source !== runId
      || row.account !== null || row.updated_at !== null || timestamp(row.created_at, stamp) !== stamp) reject()
  id(row.holding_version, 'hold')
  for (const field of ['shares', 'cost', 'market_value']) nullableNumber(row[field], 0)
  nullableNumber(row.current_weight, 0, 100); nullableNumber(row.target_weight, 0, 100)
  if (!accountCount && ['shares', 'cost', 'market_value', 'current_weight', 'target_weight'].some(field => row[field] !== null)) reject()
  if (row.shares !== null && number(row.shares) === 0 && (nullableNumber(row.market_value) !== 0 || row.cost !== null)) reject()
  return row
}
function decision(value: unknown, expectedCode: string, held: Record<string, unknown>, proof: Record<string, unknown>, chosenPolicy: string, strategy: string, stamp: bigint): Record<string, unknown> {
  const row = closed(value, ['schema_version', 'decision_id', 'evidence_id', 'fund_code', 'holding_version', 'policy_version', 'strategy_version', 'user_state', 'action', 'strength', 'confidence', 'summary', 'reason_codes', 'reasons', 'risks', 'invalidation_codes', 'invalidation_conditions', 'position_guidance', 'evidence_nodes', 'created_at'])
  if (row.schema_version !== 'v8-decision-1' || code(row.fund_code) !== expectedCode || row.holding_version !== held.holding_version
      || row.evidence_id !== proof.evidence_id || row.policy_version !== chosenPolicy || row.strategy_version !== strategy
      || row.user_state !== held.user_state || timestamp(row.created_at, stamp) !== stamp) reject()
  id(row.decision_id, 'dec'); id(row.holding_version, 'hold'); id(row.evidence_id, 'ev'); id(row.policy_version, 'pol')
  const actions = held.user_state === 'held' ? ['add', 'hold', 'reduce', 'sell'] : ['buy', 'dca', 'watch']
  if (typeof row.action !== 'string' || !actions.includes(row.action)) reject()
  integer(row.strength, 0, 100); integer(row.confidence, 0, 100); text(row.summary, 600, 1)
  const reasons = strings(row.reason_codes, 30, 1)
  if (reasons[0] !== 'ACTION_' + row.action.toUpperCase()) reject()
  strings(row.reasons, 30, 1); strings(row.risks, 30); strings(row.invalidation_codes, 30, 1); strings(row.invalidation_conditions, 30, 1)
  nodes(row.evidence_nodes)
  if (row.position_guidance !== null) {
    const guidance = closed(row.position_guidance, ['current_weight', 'target_weight', 'target_range', 'suggested_change', 'suggested_range', 'method', 'amount', 'precise'])
    nullableNumber(guidance.current_weight, 0, 100); nullableNumber(guidance.target_weight, 0, 100)
    pair(guidance.target_range); pair(guidance.suggested_range); nullableNumber(guidance.suggested_change, -100, 100)
    text(guidance.method, 240, 1); nullableNumber(guidance.amount, 0); bool(guidance.precise)
  }
  return row
}
function result(value: unknown, packet: BuiltOwnerAnalysisRequest, maximum: bigint): OwnerAnalysisResult {
  const request = packetRequest(packet), outer = closed(value, ['run', 'source_current'])
  bool(outer.source_current)
  const run = closed(outer.run, ['schema', 'request_id', 'request_hash', 'run_id', 'source', 'policy', 'strategy_version', 'created_at', 'pricing_complete', 'unavailable_codes', 'components'])
  if (run.schema !== 'owner-analysis-run-1' || run.request_id !== request.request_id || run.request_hash !== packet.requestHash) reject()
  const runId = id(run.run_id, 'owner_analysis'), strategy = text(run.strategy_version, 120, 1), stamp = timestamp(run.created_at, maximum)
  const source = closed(run.source, ['revision', 'sha256', 'record_count', 'scope'])
  if (integer(source.revision) !== request.expected_revision || source.scope !== 'fund_only') reject()
  hash(source.sha256); const recordCount = integer(source.record_count, 1, 100_000)
  const chosen = policy(run.policy, stamp)
  if (chosen.policy_version !== request.policy_version) reject()
  bool(run.pricing_complete)
  const components = list(run.components, 100, 1), unavailable = strings(run.unavailable_codes, 100)
  if (components.length !== request.evidence.length || recordCount < components.length
      || unavailable.some((item, index) => !CODE.test(item) || (index > 0 && unavailable[index - 1] >= item))) reject()
  const missing: string[] = []
  let heldAccounts = 0, weightTotal = 0, marketTotal = 0, knownTargetTotal = 0
  components.forEach((item, index) => {
    const component = closed(item, ['code', 'account_count', 'holding', 'evidence', 'decision'])
    const reference = request.evidence[index]
    if (code(component.code) !== reference.code) reject()
    const accounts = integer(component.account_count, 0, 100_000)
    heldAccounts += accounts
    const held = holding(component.holding, reference.code, runId, stamp, accounts)
    const proof = evidence(component.evidence, reference.code, stamp)
    if (proof.evidence_id !== reference.evidence_id) reject()
    const action = decision(component.decision, reference.code, held, proof, request.policy_version, strategy, stamp)
    if (accounts && held.target_weight !== null) knownTargetTotal += number(held.target_weight)
    const navAge = proof.official_nav_date === null ? Infinity
      : (Date.parse(marketDay(stamp) + 'T00:00:00Z') - Date.parse(day(proof.official_nav_date) + 'T00:00:00Z')) / 86_400_000
    const navAvailable = proof.official_nav !== null && navAge <= 7
      && !strings(proof.stale_fields, 50).some(field => ['official_nav', 'official_nav_date'].includes(field))
    if (accounts) {
      const unpriced = held.shares === null || (number(held.shares) > 0 && !navAvailable)
      if (unpriced !== (held.market_value === null)) reject()
    }
    if (accounts && held.market_value === null) missing.push(reference.code)
    if (!run.pricing_complete && held.current_weight !== null) reject()
    const neutral = !run.pricing_complete || stamp - timestamp(proof.created_at, stamp) > 7n * 86_400_000_000n
      || ['stale', 'unavailable'].includes(String(proof.estimate_status))
    if (neutral && (action.action !== (accounts ? 'hold' : 'watch') || action.position_guidance !== null
        || number(action.confidence) > 30 || number(action.strength) > 30
        || !strings(action.reason_codes, 30, 1).includes('OWNER_INPUTS_INCOMPLETE'))) reject()
    if (run.pricing_complete && accounts) {
      if (held.shares === null || held.market_value === null || held.current_weight === null) reject()
      weightTotal += number(held.current_weight)
      marketTotal += number(held.market_value)
    }
  })
  if (heldAccounts > recordCount || knownTargetTotal > 100 + 1e-9 || unavailable.join(',') !== missing.join(',')
      || run.pricing_complete !== (missing.length === 0)
      || (run.pricing_complete && (!Number.isFinite(marketTotal) || Math.abs(weightTotal - (marketTotal > 0 ? 100 : 0)) > 1e-6))) reject()
  return frozen(materialize(outer) as OwnerAnalysisResult)
}

const ERROR_STATUS: Record<string, number> = {
  invalid_analysis_request: 422, analysis_source_conflict: 409, analysis_source_empty: 409,
  analysis_inputs_unavailable: 409, analysis_evidence_unavailable: 409, analysis_policy_unavailable: 409,
  analysis_source_unavailable: 503, analysis_integrity_unavailable: 503, analysis_capacity_exhausted: 503,
  analysis_storage_unavailable: 503, analysis_timeout: 503, analysis_idempotency_conflict: 409,
}
function failure(status: number, value: unknown): OwnerAnalysisFailure {
  const row = object(value), keys = Object.keys(row)
  if (keys.length !== 1) reject()
  let code: string
  if (keys[0] === 'error') {
    const error = closed(row.error, ['code', 'message'])
    code = text(error.code, 80, 1); text(error.message, 600, 1)
    if (ERROR_STATUS[code] !== status) reject()
  } else if (keys[0] === 'detail') {
    const detail = text(row.detail, 600, 1)
    const codes: Record<number, string[]> = {
      400: ['invalid_analysis_content_length', 'analysis_body_incomplete'],
      403: ['analysis_consent_required'], 408: ['analysis_body_timeout'], 413: ['analysis_body_too_large'],
      415: ['invalid_analysis_content_type'], 422: ['invalid_analysis_request', 'invalid_analysis_query', 'invalid_analysis_request_id', 'invalid_analysis_request_hash'],
      503: ['analysis_result_unknown', 'analysis_storage_unavailable'],
    }
    if (status === 401) code = 'owner_unauthorized'
    else if (status === 403 && detail === 'Owner 会话无权执行此操作') code = 'owner_forbidden'
    else if (status === 429) code = 'analysis_rate_limited'
    else { if (!codes[status]?.includes(detail)) reject(); code = detail }
  } else return reject()
  return frozen({ kind: 'failure', status, code })
}
export function parseOwnerAnalysisWriteResponse(status: number, raw: string, packet: BuiltOwnerAnalysisRequest, nowMs = Date.now()): OwnerAnalysisWriteResponse {
  const maximum = clock(nowMs)
  packetRequest(packet)
  const value = parse(raw, OWNER_ANALYSIS_MAX_RESPONSE_BYTES)
  if (status === 200) return frozen({ kind: 'success', status: 200, result: result(value, packet, maximum) })
  return failure(status, value)
}
export function parseOwnerAnalysisReceiptResponse(status: number, raw: string, packet: BuiltOwnerAnalysisRequest, nowMs = Date.now()): OwnerAnalysisReceiptResponse {
  const maximum = clock(nowMs)
  packetRequest(packet)
  const value = parse(raw, OWNER_ANALYSIS_MAX_RESPONSE_BYTES)
  if (status === 404 || status === 503) {
    const candidate = object(value)
    if ('state' in candidate) {
      const row = closed(value, ['state', 'error'])
      if (row.state !== 'unknown' || row.error !== 'analysis_result_unknown') reject()
      return frozen({ state: 'unknown', status, error: 'analysis_result_unknown' })
    }
  }
  if (status !== 200) return failure(status, value)
  const row = closed(value, ['state', 'status', 'result'])
  if (row.state !== 'matched' || integer(row.status) !== 200) reject()
  return frozen({ state: 'matched', status: 200, result: result(row.result, packet, maximum) })
}
const checkedPolicyValues = new WeakSet<object>()
/** Shared raw grammar for closed Owner input envelopes, not a materialized DTO.
 * Retains numeric tokens until a model validator has checked their semantics. */
export function parseOwnerAnalysisJson(raw: string, maximumBytes: number): unknown {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > OWNER_ANALYSIS_MAX_RESPONSE_BYTES) reject()
  const value = parse(raw, maximumBytes)
  const remember = (item: unknown) => {
    if (item && typeof item === 'object') {
      checkedPolicyValues.add(item)
      Object.values(item).forEach(remember)
    }
  }
  remember(value)
  return frozen(value)
}
/** Only accepts an unmodified object produced by the bounded raw grammar.
 * No serialization, Python ID/hash reconstruction, or source authentication. */
export function validateOwnerAnalysisPolicyValue(value: unknown, nowMs = Date.now()): V8PortfolioPolicy {
  if (!value || typeof value !== 'object' || !checkedPolicyValues.has(value)) reject()
  return frozen(materialize(policy(value, clock(nowMs))) as V8PortfolioPolicy)
}
export function parseOwnerAnalysisPolicy(raw: string, nowMs = Date.now()): V8PortfolioPolicy {
  return validateOwnerAnalysisPolicyValue(parseOwnerAnalysisJson(raw, OWNER_ANALYSIS_MAX_RESPONSE_BYTES), nowMs)
}
export function parseOwnerAnalysisEvidence(raw: string, expectedCode: string, nowMs = Date.now()): V8EvidenceSnapshot {
  return frozen(materialize(evidence(parse(raw, OWNER_ANALYSIS_MAX_RESPONSE_BYTES), code(expectedCode), clock(nowMs))) as V8EvidenceSnapshot)
}
