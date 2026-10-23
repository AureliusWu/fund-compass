import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildOwnerAnalysisRequest, restoreOwnerAnalysisRequest,
  parseOwnerAnalysisWriteResponse, parseOwnerAnalysisReceiptResponse,
  parseOwnerAnalysisPolicy, parseOwnerAnalysisEvidence,
  OWNER_ANALYSIS_MAX_BODY_BYTES, OWNER_ANALYSIS_MAX_RESPONSE_BYTES,
  OwnerAnalysisContractError,
} from './ownerAnalysisContract'
import { ownerAnalysisBackendFixture } from './ownerAnalysisContract.fixtures'

const NOW = Date.parse('2026-10-24T00:00:00Z')
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const fixture = ownerAnalysisBackendFixture
async function packet() { const f = fixture(); return restoreOwnerAnalysisRequest(f.rawBody, f.requestHash) }
type Json = Record<string, any>
function output(): Json { return JSON.parse(fixture().response) }

describe('original analysis request packet', () => {
  it('agrees byte-for-byte with the actual backend canonical and SHA', async () => {
    const f = fixture(), built = await buildOwnerAnalysisRequest(f.request)
    expect(built.rawBody).toBe(f.rawBody)
    expect(built.requestHash).toBe(f.requestHash)
    expect(built.requestHash).toBe(sha(built.rawBody))
    expect(built.byteLength).toBe(new TextEncoder().encode(f.rawBody).byteLength)
    expect(await restoreOwnerAnalysisRequest(built.rawBody, built.requestHash)).toEqual(built)
    expect(Object.isFrozen(built.request.evidence[0])).toBe(true)
  })
  it('sorts all unique codes and isolates the packet before hashing yields', async () => {
    const input = { ...fixture().request, evidence: [fixture().request.evidence[0], { code: '000001', evidence_id: 'ev_' + 'a'.repeat(64) }] }
    const pending = buildOwnerAnalysisRequest(input)
    input.evidence[0] = { code: '999999', evidence_id: 'ev_' + 'f'.repeat(64) }
    const built = await pending
    expect(built.request.evidence.map(item => item.code)).toEqual(['000001', '510300'])
    expect(await restoreOwnerAnalysisRequest(built.rawBody, built.requestHash)).toEqual(built)
  })
  it.each([
    { expected_revision: -1 }, { expected_revision: 2 ** 53 }, { expected_revision: true },
    { request_id: 'short' }, { request_id: 'private account name' },
    { policy_version: 'pol_' + 'A'.repeat(64) }, { policy_version: 'pol_' + 'a'.repeat(64) + '\n' },
    { evidence: [] }, { evidence: [fixture().request.evidence[0], fixture().request.evidence[0]] },
    { evidence: [{ code: '５１０３００', evidence_id: 'ev_' + 'a'.repeat(64) }] },
    { evidence: [{ code: '510300', evidence_id: 'ev_' + 'a'.repeat(64), shares: 1 }] },
    { holdings: [] }, { shares: 1 }, { price: 1 },
  ])('rejects untrusted fields, aliases and invalid identity %#', async change => {
    await expect(buildOwnerAnalysisRequest({ ...fixture().request, ...change })).rejects.toMatchObject({ code: 'invalid_analysis_request' })
  })
  it('rejects hidden fields/getters/symbols and array getters without invoking them', async () => {
    let invoked = 0
    const getter = { ...fixture().request }
    Object.defineProperty(getter, 'policy_version', { enumerable: true, get() { invoked++; return fixture().request.policy_version } })
    await expect(buildOwnerAnalysisRequest(getter)).rejects.toBeInstanceOf(OwnerAnalysisContractError)
    expect(invoked).toBe(0)
    const hidden = { ...fixture().request }
    Object.defineProperty(hidden, 'private', { value: 1 })
    await expect(buildOwnerAnalysisRequest(hidden)).rejects.toBeInstanceOf(OwnerAnalysisContractError)
    await expect(buildOwnerAnalysisRequest({ ...fixture().request, [Symbol('private')]: 1 })).rejects.toBeInstanceOf(OwnerAnalysisContractError)
    const array = [...fixture().request.evidence]
    Object.defineProperty(array, '0', { value: array[0], enumerable: false })
    await expect(buildOwnerAnalysisRequest({ ...fixture().request, evidence: array })).rejects.toBeInstanceOf(OwnerAnalysisContractError)
  })
  it('enforces 100 codes and original 16 KiB without permitting alternate spellings', async () => {
    const input = { ...fixture().request, evidence: Array.from({ length: 100 }, (_, index) => ({ code: String(index).padStart(6, '0'), evidence_id: 'ev_' + 'a'.repeat(64) })) }
    expect((await buildOwnerAnalysisRequest(input)).request.evidence).toHaveLength(100)
    await expect(buildOwnerAnalysisRequest({ ...input, evidence: [...input.evidence, { code: '999999', evidence_id: 'ev_' + 'a'.repeat(64) }] })).rejects.toThrow(OwnerAnalysisContractError)
    const raw = fixture().rawBody
    for (const changed of [' ' + raw, '\ufeff' + raw, raw + ' ', raw.replace('"expected_revision":1', '"expected_revision":1.0'), raw.replace('"expected_revision":1', '"expected_revision":1,"expected_revision":1'), ' '.repeat(OWNER_ANALYSIS_MAX_BODY_BYTES) + raw]) {
      await expect(restoreOwnerAnalysisRequest(changed, sha(changed))).rejects.toMatchObject({ code: 'invalid_analysis_restore' })
    }
    await expect(restoreOwnerAnalysisRequest(raw, '0'.repeat(64))).rejects.toMatchObject({ code: 'invalid_analysis_restore' })
  })
  it('reports hash failure without returning an unhashed request packet', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => { throw Error('private unavailable runtime') }) } })
    await expect(buildOwnerAnalysisRequest(fixture().request)).rejects.toMatchObject({ code: 'analysis_hash_unavailable' })
    await expect(restoreOwnerAnalysisRequest(fixture().rawBody, fixture().requestHash)).rejects.toMatchObject({ code: 'analysis_hash_unavailable' })
  })
})

describe('actual analysis write and receipt', () => {
  it('accepts the exact backend result and matched receipt, preserving zero/null and frozen private models', async () => {
    const f = fixture(), built = await packet()
    const response = parseOwnerAnalysisWriteResponse(200, f.response, built, NOW)
    expect(response.kind).toBe('success')
    if (response.kind !== 'success') throw Error('wrong kind')
    expect(response.result.run.components[0].holding.updated_at).toBeNull()
    expect(response.result.run.components[0].holding.shares).toBe(10)
    expect(Object.isFrozen(response.result.run.components[0].evidence.evidence_nodes)).toBe(true)
    const receipt = parseOwnerAnalysisReceiptResponse(200, JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(f.response) }), built, NOW)
    expect(receipt).toEqual({ state: 'matched', status: 200, result: response.result })
    const old = output(); old.source_current = false
    const read = parseOwnerAnalysisWriteResponse(200, JSON.stringify(old), built, NOW)
    expect(read.kind === 'success' && read.result.source_current).toBe(false)
  })
  it('unknown receipts never assert absence or grant permission to resend', async () => {
    for (const status of [404, 503] as const) {
      expect(parseOwnerAnalysisReceiptResponse(status, '{"state":"unknown","error":"analysis_result_unknown"}', await packet(), NOW)).toEqual({ state: 'unknown', status, error: 'analysis_result_unknown' })
    }
    expect(() => parseOwnerAnalysisReceiptResponse(200, '{"state":"unknown","error":"analysis_result_unknown"}', {} as any, NOW)).toThrow(OwnerAnalysisContractError)
  })
  it('refuses status/body contradictions and a matched receipt for a different original packet', async () => {
    const f = fixture(), built = await packet()
    for (const [status, raw] of [
      [200, JSON.stringify({ state: 'matched', status: 409, result: JSON.parse(f.response) })],
      [404, JSON.stringify({ state: 'absent', error: 'analysis_result_unknown' })],
      [503, JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(f.response) })],
    ] as const) expect(() => parseOwnerAnalysisReceiptResponse(status, raw, built, NOW)).toThrow(OwnerAnalysisContractError)
    const different = await buildOwnerAnalysisRequest({ ...f.request, request_id: 'analysis-other-0001' })
    expect(() => parseOwnerAnalysisReceiptResponse(200, JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(f.response) }), different, NOW)).toThrow(OwnerAnalysisContractError)
    expect(() => parseOwnerAnalysisWriteResponse(409, '{"error":{"code":"analysis_timeout","message":"timeout"}}', built, NOW)).toThrow(OwnerAnalysisContractError)
  })
  it.each([
    [409, { error: { code: 'analysis_source_conflict', message: '持仓已变化' } }, 'analysis_source_conflict'],
    [503, { error: { code: 'analysis_timeout', message: '超时' } }, 'analysis_timeout'],
    [503, { detail: 'analysis_result_unknown' }, 'analysis_result_unknown'],
    [401, { detail: 'Owner 会话无效或已过期，请重新登录' }, 'owner_unauthorized'],
    [403, { detail: 'Owner 会话无权执行此操作' }, 'owner_forbidden'],
    [429, { detail: 'Owner 分析请求过于频繁' }, 'analysis_rate_limited'],
  ])('accepts fixed failure shape without exposing arbitrary response messages %#', async (status, value, expected) => {
    expect(parseOwnerAnalysisWriteResponse(status as number, JSON.stringify(value), await packet(), NOW)).toEqual({ kind: 'failure', status, code: expected })
  })
  it.each([
    (r: Json) => { r.run.request_id = 'analysis-other-0001' },
    (r: Json) => { r.run.request_hash = 'f'.repeat(64) },
    (r: Json) => { r.run.run_id = 'hold_' + 'a'.repeat(64) },
    (r: Json) => { r.run.source.revision = 0 },
    (r: Json) => { r.run.source.scope = 'total_assets' },
    (r: Json) => { r.run.source.sha256 = 'A'.repeat(64) },
    (r: Json) => { r.run.source.record_count = 0 },
    (r: Json) => { r.run.source_current = 1 },
    (r: Json) => { r.run.components = [] },
    (r: Json) => { r.run.components.push(r.run.components[0]) },
    (r: Json) => { r.run.components[0].code = '000001' },
    (r: Json) => { r.run.components[0].holding.shares = true },
    (r: Json) => { r.run.components[0].holding.current_weight = null },
    (r: Json) => { r.run.components[0].holding.source = 'owner_analysis_' + 'f'.repeat(64) },
    (r: Json) => { r.run.components[0].holding.updated_at = r.run.created_at },
    (r: Json) => { r.run.components[0].holding.account = 'private account' },
    (r: Json) => { r.run.components[0].holding.user_state = 'unheld' },
    (r: Json) => { r.run.components[0].evidence.evidence_id = 'ev_' + 'f'.repeat(64) },
    (r: Json) => { r.run.components[0].evidence.official_nav = null },
    (r: Json) => { r.run.components[0].evidence.score_coverage = 2 },
    (r: Json) => { r.run.components[0].evidence.estimate_sample_count = 0.5 },
    (r: Json) => { r.run.components[0].evidence.extra = true },
    (r: Json) => { r.run.components[0].decision.evidence_id = 'ev_' + 'f'.repeat(64) },
    (r: Json) => { r.run.components[0].decision.holding_version = null },
    (r: Json) => { r.run.components[0].decision.strategy_version = 'different-rule' },
    (r: Json) => { r.run.components[0].decision.reason_codes[0] = 'ACTION_ADD' },
    (r: Json) => { r.run.components[0].decision.strength = 101 },
    (r: Json) => { r.run.components[0].decision.action = 'add'; r.run.components[0].decision.reason_codes[0] = 'ACTION_ADD' },
    (r: Json) => { r.run.components[0].decision.confidence = 31 },
    (r: Json) => { r.run.components[0].decision.created_at = r.run.created_at.replace(/([0-9]{6})\+00:00$/, '000001+00:00') },
    (r: Json) => { r.run.components[0].evidence.official_nav_date = '2026-10-01' },
    (r: Json) => { r.run.policy.policy_version = 'pol_' + 'f'.repeat(64) },
    (r: Json) => { r.run.policy.target_allocations['000001'] = 100 },
    (r: Json) => { r.run.policy.target_ranges['000001'] = [70, 60] },
    (r: Json) => { r.run.policy.dca_rules = { max_step_percent: true } },
    (r: Json) => { r.run.policy.sell_rules = { require_structural_invalidation: 1 } },
    (r: Json) => { r.run.pricing_complete = false },
    (r: Json) => { r.run.unavailable_codes = ['510300'] },
    (r: Json) => { r.extra = true },
  ])('rejects wrong chains, incomplete code sets and malformed closed model fields %#', async mutate => {
    const r = output(); mutate(r)
    const built = await packet()
    expect(() => parseOwnerAnalysisWriteResponse(200, JSON.stringify(r), built, NOW)).toThrow(OwnerAnalysisContractError)
    expect(() => parseOwnerAnalysisReceiptResponse(200, JSON.stringify({ state: 'matched', status: 200, result: r }), built, NOW)).toThrow(OwnerAnalysisContractError)
  })
  it.each([
    (raw: string) => '\ufeff' + raw,
    (raw: string) => raw + ' trailing',
    (raw: string) => raw.replace('"source_current":true', '"source_current":true,"source_current":false'),
    (raw: string) => raw.replace('"record_count":1', '"record_count":9007199254740993'),
    (raw: string) => raw.replace('"record_count":1', '"record_count":1.0'),
    (raw: string) => raw.replace('"strength":30', '"strength":3e1'),
    (raw: string) => raw.replace('"shares":10.0', '"shares":NaN'),
    (raw: string) => raw.replace('"shares":10.0', '"shares":1e400'),
    (raw: string) => raw.replace('synthetic private analysis fund', '\\ud800'),
    (raw: string) => ' '.repeat(OWNER_ANALYSIS_MAX_RESPONSE_BYTES) + raw,
  ])('rejects malformed original JSON before normalized values can hide it %#', async mutate => {
    const built = await packet()
    expect(() => parseOwnerAnalysisWriteResponse(200, mutate(fixture().response), built, NOW)).toThrow(OwnerAnalysisContractError)
  })
  it('keeps explicit zero held and unknown held distinct without a partial denominator', async () => {
    const zero = output(), z = zero.run.components[0].holding
    Object.assign(z, { shares: 0, cost: null, market_value: 0, current_weight: 0, target_weight: 0 })
    expect(parseOwnerAnalysisWriteResponse(200, JSON.stringify(zero), await packet(), NOW).kind).toBe('success')
    const missing = output(), m = missing.run.components[0]
    missing.run.pricing_complete = false; missing.run.unavailable_codes = ['510300']
    Object.assign(m.holding, { shares: null, cost: null, market_value: null, current_weight: null })
    expect(parseOwnerAnalysisWriteResponse(200, JSON.stringify(missing), await packet(), NOW).kind).toBe('success')
    m.decision.action = 'add'; m.decision.reason_codes[0] = 'ACTION_ADD'
    const built = await packet()
    expect(() => parseOwnerAnalysisWriteResponse(200, JSON.stringify(missing), built, NOW)).toThrow(OwnerAnalysisContractError)
  })
})

describe('raw evidence and policy previews', () => {
  it('validates actual private read model bytes without fabricating a quote or issuing IO', () => {
    const noIo = vi.fn(() => { throw Error('IO forbidden') })
    vi.stubGlobal('fetch', noIo); vi.stubGlobal('localStorage', { getItem: noIo, setItem: noIo })
    const f = fixture()
    expect(parseOwnerAnalysisPolicy(f.policy, NOW).policy_version).toBe(f.request.policy_version)
    expect(parseOwnerAnalysisEvidence(f.evidence, '510300', NOW).evidence_id).toBe(f.request.evidence[0].evidence_id)
    expect(noIo).not.toHaveBeenCalled()
  })
  it('rejects future/invented calendar timestamps and wrong evidence code', () => {
    const f = fixture(), e = JSON.parse(f.evidence), p = JSON.parse(f.policy)
    for (const [field, value] of [
      ['created_at', '2027-01-01T00:00:00Z'], ['created_at', '2026-02-30T01:00:00Z'],
      ['created_at', '2026-10-23T06:00:00'], ['official_nav_date', '2027-01-01'],
      ['market_time', '2026-10-24T00:00:00Z'],
    ]) {
      expect(() => parseOwnerAnalysisEvidence(JSON.stringify({ ...e, [field]: value }), '510300', NOW)).toThrow(OwnerAnalysisContractError)
    }
    const health = structuredClone(e); health.source_states[0].last_success = '2027-01-01T00:00:00Z'
    expect(() => parseOwnerAnalysisEvidence(JSON.stringify(health), '510300', NOW)).toThrow(OwnerAnalysisContractError)
    expect(() => parseOwnerAnalysisEvidence(f.evidence, '000001', NOW)).toThrow(OwnerAnalysisContractError)
    expect(() => parseOwnerAnalysisPolicy(JSON.stringify({ ...p, effective_at: '2027-01-01T00:00:00Z' }), NOW)).toThrow(OwnerAnalysisContractError)
    expect(() => parseOwnerAnalysisPolicy('\ufeff' + f.policy, NOW)).toThrow(OwnerAnalysisContractError)
  })
  it('allows a future prediction target but never substitutes it for official NAV day', () => {
    const f = fixture(), e = JSON.parse(f.evidence)
    e.estimate = 1; e.target_nav_date = '2026-10-28'
    expect(parseOwnerAnalysisEvidence(JSON.stringify(e), '510300', NOW).target_nav_date).toBe('2026-10-28')
    e.official_nav_date = '2026-10-28'
    expect(() => parseOwnerAnalysisEvidence(JSON.stringify(e), '510300', NOW)).toThrow(OwnerAnalysisContractError)
  })
})
