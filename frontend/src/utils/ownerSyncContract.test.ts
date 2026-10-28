import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildOwnerSyncRequest, compareSyncKeys, isOwnerSyncRequestHash, normalizeOwnerSyncKey,
  OwnerSyncContractError, OWNER_SYNC_MAX_RESPONSE_BYTES, parseSyncChangesPage,
  parseSyncReceiptResponse, parseSyncWriteResponse, restoreOwnerSyncRequest,
  validateOwnerSyncRecord, validateOwnerSyncRequest,
} from './ownerSyncContract'

beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
function request(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { request_id: 'synthetic-contract-0001', expected_revision: 0, operations: [{
    key: '000001::合成账户', kind: 'holding', deleted: false,
    changes: { name: '合成基金', shares: 0, cost: null, target_weight: 0 }, base_values: {},
  }], ...patch }
}
function record(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: '000001::合成账户', kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成基金', shares: 0, cost: null, target_weight: 0 }, ...patch }
}
function page(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { upper_revision: 1, changes: [record()], next_cursor: null, complete: true, ...patch }
}
const conflict = {
  error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
  conflicts: [{ key_digest: 'a'.repeat(16), fields: ['cost', 'name'] }],
}

// Offline shared vectors: backend.models.owner_sync.parse_sync_request was
// independently run against each constructed rawBody on Python 3.14. It returned
// canonical_body == rawBody and these exact hashes. No Python runtime is needed
// by the browser/Vitest suite, and no new fixture/credential file is imported.
const SHARED_PYTHON_FIXTURES = [
  { id: 'synthetic-unicode-0001', key: '000001::合成账户😀', kind: 'holding',
    changes: { name: '合成“基金”', shares: 0, cost: null, target_weight: 0 },
    hash: 'aa0bc0b55e1476261026a71f69299c8e60b9c7dd1912fda3f1ce5c7bc518df19' },
  { id: 'synthetic-float-0001', key: 'asset:synthetic-float', kind: 'manual_asset',
    changes: { name: '合成\\现金"A"', cls: '现金', value: 1e-7, note: '合成😀与零0' },
    hash: 'daa959e277274747b5017021113d50904fbb243840b7315cd5270b2e9118c325' },
  { id: 'synthetic-zero-0001', key: '000002::', kind: 'watch',
    changes: { name: '合成关注', shares: 0, cost: 0.25, target_weight: null },
    hash: 'e18ce20a7d39435a2be5be227267f86032709e571bd55e885d0b4f7889590a93' },
  { id: 'synthetic-escape-0001', key: 'asset:synthetic-escape', kind: 'manual_asset',
    changes: { name: '合成"quote\\slash', cls: '商品', value: 12.5, note: null },
    hash: '6a53c6cea9c3f5be43806c3563dc0ea2e687fa3f0fdb683065e402f0dfd8b931' },
]

describe('pure Owner sync request construction and byte-exact restore', () => {
  it.each(SHARED_PYTHON_FIXTURES)('matches independently computed Python canonical/hash: $id', async vector => {
    const built = await buildOwnerSyncRequest({ request_id: vector.id, expected_revision: 0,
      operations: [{ key: vector.key, kind: vector.kind, deleted: false, changes: vector.changes, base_values: {} }] })
    expect(built.requestHash).toBe(vector.hash)
    expect(built.requestHash).toBe(sha(built.rawBody))
    expect(built.byteLength).toBe(new TextEncoder().encode(built.rawBody).byteLength)
    expect(await restoreOwnerSyncRequest(built.rawBody, built.requestHash)).toEqual(built)
  })
  it('sorts closed ASCII keys, preserves omission/null/zero and copies/freezes input', async () => {
    const input = request()
    const built = await buildOwnerSyncRequest(input)
    expect(built.rawBody.startsWith('{"expected_revision":0,"operations":')).toBe(true)
    expect(built.request.operations[0].changes).toEqual({ name: '合成基金', shares: 0, cost: null, target_weight: 0 })
    expect(Reflect.set(built.request.operations[0].changes!, 'cost', 8)).toBe(false)
    expect(Object.isFrozen(built.request.operations)).toBe(true)
    ;(input.operations as { changes: { cost: unknown } }[])[0].changes.cost = 8
    expect(built.rawBody).toContain('"cost":null')
    const omitted = await buildOwnerSyncRequest(request({ operations: [{ key: '000001::', kind: 'watch', deleted: false }] }))
    expect(omitted.rawBody).not.toContain('changes')
    const explicit = await buildOwnerSyncRequest(request({ operations: [{ key: '000001::', kind: 'watch', deleted: false, changes: {} }] }))
    expect(explicit.requestHash).not.toBe(omitted.requestHash)
  })
  it('normalizes new identities once, rejects normalized duplicate identity and preserves internal spaces', () => {
    expect(normalizeOwnerSyncKey('holding', '000001::\u00a0合成 A  B\ufeff')).toBe('000001::合成 A  B')
    expect(normalizeOwnerSyncKey('watch', '000001::' + '😀'.repeat(32))).toContain('😀'.repeat(32))
    const row = { key: '000001::A', kind: 'watch', deleted: false }
    expect(() => validateOwnerSyncRequest(request({ operations: [row, { ...row, key: '000001:: A ' }] }))).toThrow(OwnerSyncContractError)
  })
  it.each([
    { extra: 'synthetic private input' }, { request_id: 'short' }, { request_id: 'synthetic-0001\n' },
    { expected_revision: true }, { expected_revision: -1 }, { expected_revision: 0.5 },
    { expected_revision: Number.MAX_SAFE_INTEGER + 1 }, { operations: [] }, { operations: null },
  ])('rejects closed top-level shape/strict revisions without echoing: %j', patch => {
    try { validateOwnerSyncRequest(request(patch)); expect.fail('accepted invalid request') }
    catch (error) { expect(error).toMatchObject({ code: 'invalid_sync_request', message: 'Owner sync contract rejected' }) }
  })
  it.each([
    { kind: 'cash' }, { key: 'asset:synthetic-wrong-kind' }, { deleted: 0 }, { extra: null },
    { changes: { shares: true } }, { changes: { cost: '0' } }, { changes: { cost: NaN } },
    { changes: { cost: Infinity } }, { changes: { cost: -1 } }, { changes: { cost: Number.MAX_SAFE_INTEGER + 1 } },
    { changes: { target_weight: 101 } }, { changes: { name: null } }, { changes: { name: '　' } },
    { changes: { name: '😀'.repeat(101) } }, { changes: { name: '\ud800' } }, { changes: { name: 'synthetic\x85private' } },
    { changes: { revision: 1 } }, { changes: null }, { base_values: { deleted: null } }, { base_values: { kind: null } },
  ])('rejects closed operation/finance/Unicode shapes: %j', patch => {
    const input = request(); input.operations = [{ ...(input.operations as Record<string, unknown>[])[0], ...patch }]
    expect(() => validateOwnerSyncRequest(input)).toThrow(OwnerSyncContractError)
  })
  it('uses UTF8 byte bound and rejects oversized batches, getters and exotic inputs', async () => {
    const operations = Array.from({ length: 200 }, (_, index) => ({ key: 'asset:synthetic-' + index, kind: 'manual_asset', deleted: false,
      changes: { name: '合成', cls: '现金', value: 0, note: '中'.repeat(1000) } }))
    await expect(buildOwnerSyncRequest(request({ operations }))).rejects.toMatchObject({ code: 'invalid_sync_request' })
    expect(() => validateOwnerSyncRequest(request({ operations: [...operations, operations[0]] }))).toThrow(OwnerSyncContractError)
    let read = false
    const input = request()
    Object.defineProperty(input, 'request_id', { enumerable: true, get() { read = true; return 'synthetic-0001' } })
    expect(() => validateOwnerSyncRequest(input)).toThrow(OwnerSyncContractError)
    expect(read).toBe(false)
    expect(() => validateOwnerSyncRequest(Object.assign(request(), { [Symbol('hidden')]: 'private' }))).toThrow(OwnerSyncContractError)
  })
  it('restores only constructed canonical text, not arbitrary external JSON or reformatted retries', async () => {
    const built = await buildOwnerSyncRequest(request())
    const variants = [built.rawBody + ' ', built.rawBody.replace('"shares":0', '"shares":0.0'),
      built.rawBody.replace('"shares":0', '"shares":0,"shares":0'),
      built.rawBody.replace('"shares":0', '"shar\\u0065s":0,"shares":0'),
      built.rawBody.replace('"expected_revision":0', '"expected_revision":0.0'),
      JSON.stringify(JSON.parse(built.rawBody), null, 1), built.rawBody.replace('合成账户', ' 合成账户 ')]
    for (const raw of variants) await expect(restoreOwnerSyncRequest(raw, sha(raw))).rejects.toMatchObject({ code: 'invalid_sync_restore' })
    await expect(restoreOwnerSyncRequest(built.rawBody, 'a'.repeat(64))).rejects.toMatchObject({ code: 'invalid_sync_restore' })
    expect(isOwnerSyncRequestHash(built.requestHash + '\n')).toBe(false)
    expect(isOwnerSyncRequestHash(built.requestHash.toUpperCase())).toBe(false)
  })
  it('has no fetch/storage/session side effects', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const built = await buildOwnerSyncRequest(request())
    await restoreOwnerSyncRequest(built.rawBody, built.requestHash)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses to invent a digest when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined)
    await expect(buildOwnerSyncRequest(request())).rejects.toMatchObject({ code: 'sync_hash_unavailable' })
  })
  it('accepts backend-compatible finite exponent floats but not unsafe integer tokens', async () => {
    const input = request()
    input.operations = [{ key: 'asset:synthetic-large-float', kind: 'manual_asset', deleted: false,
      changes: { name: '合成', cls: '现金', value: 1e308, note: null } }]
    const built = await buildOwnerSyncRequest(input)
    expect(built.rawBody).toContain('1e+308')
    expect(await restoreOwnerSyncRequest(built.rawBody, built.requestHash)).toEqual(built)
  })
})

describe('closed bounded Owner sync response contracts', () => {
  it('preserves confirmed zero/null, tombstones and finite float tokens', () => {
    const success = parseSyncWriteResponse(200, JSON.stringify({ revision: 1, records: [record({ deleted: true })] }))
    expect(success.kind).toBe('success')
    if (success.kind === 'success') {
      expect(success.result.records[0].deleted).toBe(true)
      expect(success.result.records[0].values.cost).toBeNull()
      expect(success.result.records[0].values.shares).toBe(0)
      expect(Object.isFrozen(success.result.records[0].values)).toBe(true)
    }
    expect(parseSyncWriteResponse(200, JSON.stringify({ revision: 1, records: [record()] }).replace('"shares":0', '"shares":0.0')).kind).toBe('success')
  })
  it.each([
    { extra: 'synthetic-private' }, { lifecycle_revision: 2 }, { record_revision: 0 }, { deleted: 1 },
    { field_revisions: { name: 1, shares: true, cost: 1, target_weight: 1 } },
    { field_revisions: { name: 1, shares: 1, cost: 2, target_weight: 1 } },
    { values: { name: '合成', shares: false, cost: null, target_weight: 0 } },
    { key: '000001:: 合成账户' }, { kind: 'watch', values: { name: '合成', shares: 1, cost: null, target_weight: 0 } },
  ])('rejects invalid record envelope: %j', patch => {
    expect(() => validateOwnerSyncRecord(record(patch), 1)).toThrow(OwnerSyncContractError)
  })
  it('rejects integer revisions encoded as floats, unsafe numbers, duplicate keys and unbounded raw input', () => {
    const raw = JSON.stringify({ revision: 1, records: [record()] })
    for (const bad of [raw.replace('"revision":1', '"revision":1.0'), raw.replace('"revision":1', '"revision":true'),
      raw.replace('"revision":1', '"revision":9007199254740992'), raw.replace('"cost":null', '"cost":1e999'),
      raw.replace('"name":"合成基金"', '"name":"合成基金","name":"secret"'),
      raw.replace('"name":"合成基金"', '"na\\u006de":"合成基金","name":"secret"'), raw + ' trailing',
      '{"synthetic":' + '['.repeat(9) + '0' + ']'.repeat(9) + '}', ' '.repeat(OWNER_SYNC_MAX_RESPONSE_BYTES + 1)]) {
      expect(() => parseSyncWriteResponse(200, bad)).toThrow(OwnerSyncContractError)
    }
    expect(() => parseSyncWriteResponse(200, JSON.stringify({ revision: 1, records: [record(), record()] }))).toThrow(OwnerSyncContractError)
  })
  it('checks complete JSON grammar, strings/prototype keys and deterministic error messages', () => {
    for (const raw of ['', '{', '{"x":1,}', '[1,]', '{"x":01}', '{"x":.5}', '{"x":NaN}', '{"x":"\\udfff"}',
      '{"x":"\\q"}', '{"__proto__":{"private":true}}']) expect(() => parseSyncWriteResponse(200, raw)).toThrow(OwnerSyncContractError)
    expect(({} as { private?: boolean }).private).toBeUndefined()
    expect(() => parseSyncWriteResponse(503, JSON.stringify({ error: { code: 'storage_unavailable', message: 'synthetic provider private body' } }))).toThrow(OwnerSyncContractError)
  })
  it('bounds complete JSON nodes before closed-shape validation and rejects private thrown input errors', () => {
    expect(() => parseSyncWriteResponse(200, '{"synthetic":[' + '0,'.repeat(50_000) + '0]}')).toThrow(OwnerSyncContractError)
    const malicious = new Proxy({}, { getPrototypeOf() { throw new Error('synthetic-private-input-error') } })
    try { validateOwnerSyncRecord(malicious); expect.fail('accepted invalid input') }
    catch (error) { expect(error).toMatchObject({ message: 'Owner sync contract rejected', code: 'invalid_sync_contract' }) }
  })
  it('validates manual records and permits old field stamps across a kind lifecycle change', () => {
    const manual = record({ key: 'asset:synthetic-manual', kind: 'manual_asset', record_revision: 3, lifecycle_revision: 2,
      field_revisions: { name: 1, cls: 2, value: 3, note: 2 }, values: { name: '合成现金', cls: '现金', value: 0, note: null } })
    expect(validateOwnerSyncRecord(manual, 3).values.value).toBe(0)
    for (const bad of [record({ ...manual, values: { name: '合成', cls: '现金', value: null, note: null } }),
      record({ ...manual, field_revisions: { name: 1, cls: 2, value: 3 } })]) {
      expect(() => validateOwnerSyncRecord(bad, 3)).toThrow(OwnerSyncContractError)
    }
  })
  it('keeps deterministic 409 conflicts separate from ID reuse and failures never prove rollback', () => {
    expect(parseSyncWriteResponse(409, JSON.stringify(conflict))).toMatchObject({ kind: 'conflict', status: 409 })
    expect(parseSyncWriteResponse(409, JSON.stringify({ error: { code: 'idempotency_conflict', message: '请求标识已用于不同的同步请求。' } }))).toMatchObject({ kind: 'idempotency_conflict' })
    expect(parseSyncWriteResponse(401, '{"detail":"Owner 会话无效或已过期，请重新登录"}')).toMatchObject({ kind: 'failure', status: 401 })
    expect(parseSyncWriteResponse(503, '{"detail":"sync_result_unknown"}')).toMatchObject({ kind: 'failure', code: 'sync_result_unknown' })
    for (const fields of [[], ['name', 'cost'], ['cost', 'cost'], ['holding_version']]) {
      expect(() => parseSyncWriteResponse(409, JSON.stringify({ ...conflict, conflicts: [{ key_digest: 'a'.repeat(16), fields }] }))).toThrow(OwnerSyncContractError)
    }
  })
  it('receipts accept only exact matched shapes and absent/unavailable remain unknown', () => {
    expect(parseSyncReceiptResponse(200, JSON.stringify({ state: 'matched', status: 200, result: { revision: 1, records: [record()] } }))).toMatchObject({ state: 'matched', status: 200 })
    expect(parseSyncReceiptResponse(200, JSON.stringify({ state: 'matched', status: 409, result: conflict }))).toMatchObject({ state: 'matched', status: 409 })
    for (const status of [404, 503]) expect(parseSyncReceiptResponse(status, '{"state":"unknown","error":"sync_result_unknown"}')).toEqual({ state: 'unknown', status, error: 'sync_result_unknown' })
    for (const payload of [{ state: 'matched', result: {} }, { state: 'matched', status: 201, result: {} },
      { state: 'matched', status: 200, result: { revision: 0, records: [] }, request_hash: 'a'.repeat(64) }]) {
      expect(() => parseSyncReceiptResponse(200, JSON.stringify(payload))).toThrow(OwnerSyncContractError)
    }
    expect(() => parseSyncReceiptResponse(404, '{"state":"absent","error":"sync_result_unknown"}')).toThrow(OwnerSyncContractError)
    expect(() => parseSyncReceiptResponse(503, '{"detail":"synthetic-private-driver"}')).toThrow(OwnerSyncContractError)
  })
})

describe('fixed upper revision and UTF8 BINARY cursor pages', () => {
  it('uses SQLite Unicode order instead of JS UTF16/locale sorting', () => {
    const bmp = '000001::\ue000', astral = '000001::😀'
    expect(bmp < astral).toBe(false)
    expect(compareSyncKeys(bmp, astral)).toBe(-1)
    const parsed = parseSyncChangesPage(JSON.stringify(page({ changes: [record({ key: bmp }), record({ key: astral })] })), { sinceRevision: 0, limit: 2 })
    expect(parsed.changes.map(row => row.key)).toEqual([bmp, astral])
    expect(() => parseSyncChangesPage(JSON.stringify(page({ changes: [record({ key: astral }), record({ key: bmp })] })), { sinceRevision: 0, limit: 2 })).toThrow(OwnerSyncContractError)
  })
  it('pins upper, validates strict cursor progress and next cursor equals final item', () => {
    const first = parseSyncChangesPage(JSON.stringify(page({ next_cursor: [1, '000001::合成账户'], complete: false })), { sinceRevision: 0, limit: 1 })
    expect(first.next_cursor).toEqual([1, '000001::合成账户'])
    const later = record({ key: '000002::合成账户' })
    expect(parseSyncChangesPage(JSON.stringify(page({ changes: [later] })), { sinceRevision: 0, upperRevision: 1, cursor: first.next_cursor!, limit: 1 }).complete).toBe(true)
    for (const bad of [page({ upper_revision: 2 }), page({ next_cursor: [1, '000001::错误'], complete: false }),
      page({ next_cursor: null, complete: false }), page({ next_cursor: [1, '000001::合成账户'] }), page({ changes: [] }),
      page({ changes: [record(), record()] }), page({ changes: [record({ record_revision: 2 })] })]) {
      expect(() => parseSyncChangesPage(JSON.stringify(bad), { sinceRevision: 0, upperRevision: 1, limit: 1 })).toThrow(OwnerSyncContractError)
    }
    expect(() => parseSyncChangesPage(JSON.stringify(page()), { sinceRevision: 0, upperRevision: 1, cursor: [1, '000001::合成账户'] })).toThrow(OwnerSyncContractError)
  })
  it('keeps append history records with the same key at different revisions', () => {
    const later = record({ record_revision: 2, field_revisions: { name: 1, shares: 1, cost: 2, target_weight: 1 },
      values: { name: '合成基金', shares: 0, cost: 2, target_weight: 0 } })
    const parsed = parseSyncChangesPage(JSON.stringify(page({ upper_revision: 2, changes: [record(), later] })), { sinceRevision: 0 })
    expect(parsed.changes.map(row => row.record_revision)).toEqual([1, 2])
    expect(parsed.changes[0].values.cost).toBeNull()
  })
  it.each([
    { sinceRevision: true }, { sinceRevision: -1 }, { sinceRevision: 0, limit: 0 }, { sinceRevision: 0, limit: 201 },
    { sinceRevision: 0, cursor: [1, '000001::A'] }, { sinceRevision: 1, upperRevision: 1, cursor: [1, '000001::A'] },
    { sinceRevision: 0, upperRevision: 1, cursor: [2, '000001::A'] }, { sinceRevision: 0, extra: 'private' },
  ])('rejects invalid page request context: %j', context => {
    expect(() => parseSyncChangesPage(JSON.stringify(page()), context as unknown as { sinceRevision: number })).toThrow(OwnerSyncContractError)
  })
  it('accepts genuinely empty confirmed checkpoints, not empty future snapshots', () => {
    expect(parseSyncChangesPage(JSON.stringify(page({ upper_revision: 0, changes: [] })), { sinceRevision: 0 }).upper_revision).toBe(0)
    expect(parseSyncChangesPage(JSON.stringify(page({ changes: [] })), { sinceRevision: 1 }).changes).toEqual([])
  })
})
