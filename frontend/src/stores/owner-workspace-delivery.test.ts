import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from './ownerSyncCandidate'
import type { OwnerSyncOutboxState } from './ownerSyncOutbox'
import type { OwnerWorkspaceSyncState } from './owner-workspace'
import { buildOwnerSyncRequest, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { planOwnerWorkspaceCloudIntent } from '@/utils/owner-workspace-sync'
import * as ackPlanner from '@/utils/owner-workspace-ack'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import {
  buildOwnerWorkspaceAckCloudRequest, previewOwnerWorkspaceAck, rehydrateOwnerWorkspaceAckCloudRequest,
  validateOwnerWorkspaceDeliveryRequest, type OwnerWorkspaceAckCloudInput,
} from './owner-workspace-delivery'

const TARGET = 'a'.repeat(64), KEY = '000001::synthetic-account', PRIVATE = 'synthetic-private-not-an-error-message'
const STATES: readonly OwnerSyncOutboxState[] = ['prepared', 'attempted', 'unknown', 'confirmed', 'conflict']
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function sha(raw: string): string { return createHash('sha256').update(raw, 'utf8').digest('hex') }
function copy<T>(value: T): T { return structuredClone(value) }
function frozen(value: unknown): void {
  if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
}
function record(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch } as OwnerSyncRecord
}
function entry(source = record(), patch: Record<string, unknown> = {}): OwnerWorkspaceEntry {
  return { key: source.key, kind: source.kind, deleted: source.deleted, values: { ...source.values },
    local_pending: true, ...patch } as unknown as OwnerWorkspaceEntry
}
function changed(source = record(), cost: number | null = 8, at = 2): OwnerSyncRecord {
  return record({ ...source, record_revision: at, values: { ...source.values, cost },
    field_revisions: { ...source.field_revisions, cost: at } })
}
function baseline(records: readonly OwnerSyncRecord[], head = Math.max(0, ...records.map(row => row.record_revision))): OwnerSyncBaseline {
  return { pulledRevision: head, records }
}
async function fixture(options: {
  slot?: OwnerSyncOutboxState; receipt?: boolean; conflict?: boolean; base?: OwnerSyncBaseline;
  snapshot?: OwnerWorkspaceSnapshot; cloud?: OwnerSyncBaseline;
} = {}): Promise<OwnerWorkspaceAckCloudInput> {
  const before = record(), base = options.base ?? baseline([before]), post = changed(before),
    snapshot = options.snapshot ?? { localVersion: 7, entries: [entry(before, { values: { ...before.values, cost: 8 } })],
      legacy: { sourceKey: 'sinan_watchlist_v2' as const, raw: PRIVATE } }
  const intent = planOwnerWorkspaceCloudIntent(base, snapshot)
  expect(intent.issues).toEqual([])
  const packet = await buildOwnerSyncRequest({ request_id: 'synthetic-original-0001', expected_revision: base.pulledRevision,
    operations: intent.operations })
  const archive = snapshot.legacy === null ? { sourceKey: null, v1Raw: null, v2Raw: null }
    : { sourceKey: snapshot.legacy.sourceKey, v1Raw: snapshot.legacy.sourceKey === 'sinan_watchlist_v1' ? snapshot.legacy.raw : null,
      v2Raw: snapshot.legacy.sourceKey === 'sinan_watchlist_v2' ? snapshot.legacy.raw : null }
  const metadata = { schema: 'owner-workspace-local-1' as const,
    adoption: { id: 'synthetic-adoption-0001', hash: 'b'.repeat(64), backupSha256: 'c'.repeat(64), sourceArchive: archive,
      localVersion: snapshot.localVersion }, displayTimes: snapshot.entries.map(row => ({ key: row.key, updated_at: null })),
    recentEdit: null, restoredArchives: [] }
  const sync = { schema: 'owner-workspace-sync-1' as const, targetFingerprint: TARGET, epoch: 2, base,
    pending: { requestId: packet.request.request_id, requestHash: packet.requestHash, rawBody: packet.rawBody,
      preimageHash: 'd'.repeat(64), preparationHash: 'e'.repeat(64), adoptionId: metadata.adoption.id,
      adoptionHash: metadata.adoption.hash, localVersion: snapshot.localVersion, preparedOutboxVersion: 6,
      baseRevision: base.pulledRevision },
    recentReceipt: { id: 'synthetic-link-0001', hash: 'f'.repeat(64), operation: 'link' as const,
      syncEpoch: 1, outboxVersion: 2, localVersion: snapshot.localVersion } }
  const expected = { local: { snapshot, outbox: { version: 8, entry: { schema: 'owner-sync-outbox-1' as const,
    state: options.slot ?? (options.conflict ? 'conflict' : 'confirmed'), rawBody: packet.rawBody, requestHash: packet.requestHash } },
    metadata, receiptCount: 3, sync }, sync } as OwnerWorkspaceSyncState
  const status = options.conflict ? 409 : 200
  const result = options.conflict ? { error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
    conflicts: [{ key_digest: sha(KEY).slice(0, 16), fields: ['cost'] }] } : { revision: 2, records: [post] }
  return { id: 'synthetic-ack-0001', expected, matchedResult: { source: options.receipt ? 'receipt' : 'write',
    requestId: packet.request.request_id, requestHash: packet.requestHash, status: options.receipt ? 200 : status,
    rawBody: JSON.stringify(options.receipt ? { state: 'matched', status, result } : result) },
    completeBaseline: options.cloud ?? baseline([options.conflict ? changed(before, 20) : post]),
    minimumObservedRevision: 0, resolutions: [] }
}
function delivery(input: OwnerWorkspaceAckCloudInput, nextState: unknown = 'attempted'): Record<string, unknown> {
  const pending = input.expected.sync.pending!
  return { expected: input.expected, requestId: pending.requestId, requestHash: pending.requestHash,
    preparationHash: pending.preparationHash, nextState }
}
function at(input: unknown, path: string): Record<string, unknown> {
  let value = input as Record<string, unknown>
  for (const key of path.split('.').filter(Boolean)) value = value[key] as Record<string, unknown>
  return value
}
function replace(input: unknown, path: string, value: unknown): void {
  const parts = path.split('.'), key = parts.pop()!
  at(input, parts.join('.'))[key] = value
}
function rejectDelivery(input: unknown, target = TARGET): void {
  expect(() => validateOwnerWorkspaceDeliveryRequest(target, input)).toThrowError(expect.objectContaining({ code: 'invalid_delivery' }))
}
async function rejectAck(input: unknown, code = 'invalid_ack', target = TARGET): Promise<void> {
  await expect(buildOwnerWorkspaceAckCloudRequest(target, input as OwnerWorkspaceAckCloudInput))
    .rejects.toMatchObject({ code, message: 'Owner workspace managed operation rejected' })
}

describe('managed strict delivery full-preimage contract', () => {
  it.each(STATES.flatMap(from => STATES.map(to => [from, to] as const)))('allows only original-packet transition %s -> %s', async (from, to) => {
    const input = delivery(await fixture({ slot: from }), to), allowed = ({ prepared: ['attempted'], attempted: ['unknown', 'confirmed', 'conflict'],
      unknown: ['confirmed', 'conflict'], confirmed: [], conflict: [] } as Record<string, string[]>)[from].includes(to)
    if (allowed) {
      const original = canonicalOwnerLocal(input), result = validateOwnerWorkspaceDeliveryRequest(TARGET, input)
      expect(result).toEqual(input); frozen(result)
      expect(result.expected).not.toBe(input.expected)
      expect(canonicalOwnerLocal(input)).toBe(original)
      expect(result.expected.local.sync).toBe(result.expected.sync)
    } else rejectDelivery(input)
  })

  it('preserves full B, sync epoch, preparation version, original bytes, source archives and independent local/outbox counters', async () => {
    const source = await fixture({ slot: 'attempted' }), request = delivery(source, 'unknown'), result = validateOwnerWorkspaceDeliveryRequest(TARGET, request)
    expect(result.expected.sync).toEqual(source.expected.sync)
    expect(result.expected.sync.epoch).toBe(2)
    expect(result.expected.sync.pending!.preparedOutboxVersion).toBe(6)
    expect(result.expected.local.outbox.version).toBe(8)
    expect(result.expected.local.snapshot.localVersion).toBe(7)
    expect(result.expected.local.metadata.adoption!.sourceArchive.v2Raw).toBe(PRIVATE)
    expect(Object.isFrozen(source.expected)).toBe(false)
    replace(source, 'expected.local.receiptCount', 4)
    expect(result.expected.local.receiptCount).toBe(3)
  })

  it.each([
    ['requestId', 'synthetic-other-0001'], ['requestHash', '0'.repeat(64)], ['preparationHash', '0'.repeat(64)],
    ['requestHash', 'A'.repeat(64)], ['requestHash', 'a'.repeat(64) + '\n'], ['preparationHash', new String('e'.repeat(64))],
    ['nextState', new String('attempted')], ['nextState', null], ['nextState', 'prepared'],
  ])('rejects changed binding/native field %s (%s)', async (path, value) => {
    const input = delivery(await fixture({ slot: 'prepared' })); replace(input, path as string, value); rejectDelivery(input)
  })

  it.each([
    ['local.receiptCount', -0], ['local.receiptCount', 201], ['local.receiptCount', true],
    ['local.outbox.version', -0], ['local.outbox.version', 5], ['local.snapshot.localVersion', -0],
    ['sync.epoch', -0], ['sync.epoch', 3], ['sync.pending.localVersion', 8],
    ['sync.pending.adoptionHash', '0'.repeat(64)], ['sync.pending.baseRevision', 2],
    ['sync.pending.preparedOutboxVersion', 9], ['sync.pending.preparedOutboxVersion', 2],
    ['sync.pending.rawBody', '{}'], ['local.outbox.entry.requestHash', '0'.repeat(64)],
    ['sync.recentReceipt.syncEpoch', 2], ['sync.recentReceipt.localVersion', 8],
    ['local.metadata.adoption', null], ['sync.base', null], ['sync.pending', null], ['local.outbox.entry', null],
  ])('rejects broken full preimage relation %s', async (path, value) => {
    const input = delivery(await fixture({ slot: 'prepared' })); replace(at(input, 'expected'), path as string, value); rejectDelivery(input)
  })

  it('requires both identical complete sync copies and refuses v3/local-only or omitted metadata', async () => {
    const input = delivery(await fixture({ slot: 'prepared' }))
    replace(input, 'expected.local.sync', copy(at(input, 'expected.sync')))
    replace(input, 'expected.local.sync.pending.preparationHash', '0'.repeat(64)); rejectDelivery(input)
    const missing = delivery(await fixture({ slot: 'prepared' })); delete at(missing, 'expected.local').sync; rejectDelivery(missing)
  })

  it.each([TARGET + '\n', TARGET + '\r\n', new String(TARGET), null, 'A'.repeat(64)])('rejects malformed target before accepting a packet (%s)', async target => {
    rejectDelivery(delivery(await fixture({ slot: 'prepared' })), target as string)
  })
})

describe('native closed request and nested DTOs', () => {
  it.each([
    'expected', 'requestId', 'requestHash', 'preparationHash', 'nextState', 'expected.local', 'expected.sync',
    'expected.local.snapshot', 'expected.local.outbox', 'expected.local.metadata', 'expected.local.receiptCount', 'expected.local.sync',
    'expected.local.outbox.entry', 'expected.local.outbox.entry.state', 'expected.local.outbox.entry.rawBody',
    'expected.local.snapshot.entries', 'expected.local.snapshot.entries.0.values.cost',
    'expected.local.metadata.adoption.hash', 'expected.sync.pending.preparationHash', 'expected.sync.base.records.0.values.cost',
  ])('rejects delivery accessor without invoking %s', async path => {
    const input = delivery(await fixture({ slot: 'prepared' })), parts = path.split('.'), key = parts.pop()!, getter = vi.fn(() => PRIVATE)
    Object.defineProperty(at(input, parts.join('.')), key, { enumerable: true, get: getter })
    rejectDelivery(input); expect(getter).not.toHaveBeenCalled()
  })

  it.each(['', 'expected', 'expected.local', 'expected.local.outbox.entry', 'expected.sync.pending'])('rejects native shape extras/prototypes at %s', async path => {
    for (const kind of ['extra', 'symbol', 'hidden', 'prototype']) {
      const input = delivery(await fixture({ slot: 'prepared' })), row = at(input, path)
      if (kind === 'extra') row.extra = PRIVATE
      if (kind === 'symbol') Object.defineProperty(row, Symbol('hidden'), { enumerable: true, value: PRIVATE })
      if (kind === 'hidden') Object.defineProperty(row, 'hidden', { value: PRIVATE })
      if (kind === 'prototype') Object.setPrototypeOf(row, { inherited: PRIVATE })
      rejectDelivery(input)
    }
  })

  it('accepts independent plain-null prototypes instead of granting inherited properties', async () => {
    const input = delivery(await fixture({ slot: 'prepared' }))
    for (const path of ['', 'expected', 'expected.local', 'expected.local.outbox', 'expected.local.outbox.entry', 'expected.sync.pending']) {
      Object.setPrototypeOf(at(input, path), null)
    }
    expect(validateOwnerWorkspaceDeliveryRequest(TARGET, input).nextState).toBe('attempted')
  })
})

describe('raw-result acknowledgement construction', () => {
  it.each([false, true])('builds and rehydrates raw matched result (receipt=%s), never business-confirming the local workspace', async receipt => {
    const input = await fixture({ receipt }), original = canonicalOwnerLocal(input), preview = await previewOwnerWorkspaceAck(TARGET, input)
    expect(preview.issues).toEqual([]); expect(preview.outcome).toBe('success')
    expect(preview.nextSnapshot!.entries[0].values).toEqual({ name: 'synthetic-fund', shares: 0, cost: 8, target_weight: null })
    expect(preview.nextSnapshot!.entries[0].local_pending).toBe(true)
    const request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input), restored = await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, request)
    expect(request.hash).toBe(sha(canonicalOwnerLocal({ operation: 'cloud-ack-1', target: TARGET, input, preview })))
    expect(restored.request).toEqual(request); expect(restored.preview).toEqual(preview)
    frozen(request); frozen(preview); frozen(restored)
    expect(canonicalOwnerLocal(input)).toBe(original)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it('retains full manual assets, tombstones and their revision metadata in D without importing them as fund rows', async () => {
    const manual = record({ key: 'asset:synthetic-manual', kind: 'manual_asset', field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
      values: { name: 'synthetic-manual', cls: '现金', value: 0, note: null } }), tombstone = record({ ...manual, key: 'asset:synthetic-deleted', deleted: true }),
      input = await fixture({ base: baseline([record(), manual, tombstone]), cloud: baseline([changed(), manual, tombstone]) }),
      result = await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, await buildOwnerWorkspaceAckCloudRequest(TARGET, input))
    expect(result.preview.baseD).toEqual(input.completeBaseline)
    expect(result.preview.excludedManualAssets).toBe(2)
    expect(result.preview.nextSnapshot!.entries).toHaveLength(1)
    expect(result.preview.nextSnapshot!.entries[0].values.shares).toBe(0)
    expect(result.preview.nextSnapshot!.entries[0].values.target_weight).toBeNull()
  })

  it('preserves original local negative zero distinctly from nullable values and wire zero', async () => {
    const source = await fixture(), snapshot = copy(source.expected.local.snapshot)
    replace(snapshot, 'entries.0.values.shares', -0)
    const input = await fixture({ snapshot }), request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input),
      result = await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, request)
    expect(Object.is(result.preview.nextSnapshot!.entries[0].values.shares, -0)).toBe(true)
    expect(result.preview.nextSnapshot!.entries[0].values.target_weight).toBeNull()
    expect(Object.is(result.preview.baseD!.records[0].values.shares, 0)).toBe(true)
    expect(Object.is(request.expected.local.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(request.hash).not.toBe((await buildOwnerWorkspaceAckCloudRequest(TARGET, source)).hash)
  })

  it('hashes actual operation keys instead of trusting a caller digest association', async () => {
    const input = await fixture({ conflict: true }), digest = vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle))
    vi.stubGlobal('crypto', { subtle: { digest } })
    const unresolved = await previewOwnerWorkspaceAck(TARGET, input)
    expect(unresolved.outcome).toBe('conflict'); expect(unresolved.conflicts).toMatchObject([{ key: KEY, field: 'cost' }])
    expect(digest.mock.calls.some(([, bytes]) => new TextDecoder().decode(bytes as ArrayBuffer) === KEY)).toBe(true)
    const forged = copy(input), body = JSON.parse(forged.matchedResult.rawBody)
    body.conflicts[0].key_digest = '0'.repeat(16); replace(forged, 'matchedResult.rawBody', JSON.stringify(body))
    await rejectAck(forged)
  })

  it('previews unresolved conflict but prohibits a request until an explicit choice resolves all conflicts', async () => {
    const input = await fixture({ conflict: true }), preview = await previewOwnerWorkspaceAck(TARGET, input)
    expect(preview.outcome).toBe('conflict'); expect(preview.issues).toEqual([]); expect(preview.nextSnapshot).toBeNull()
    await rejectAck(input, 'ack_unresolved')
    const local = await buildOwnerWorkspaceAckCloudRequest(TARGET, { ...input, resolutions: [{ key: KEY, field: 'cost', choice: 'local' }] })
    const cloud = await buildOwnerWorkspaceAckCloudRequest(TARGET, { ...input, resolutions: [{ key: KEY, field: 'cost', choice: 'cloud' }] })
    expect(local.hash).not.toBe(cloud.hash)
    expect((await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, local)).preview.nextSnapshot!.entries[0].values.cost).toBe(8)
    expect((await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, cloud)).preview.nextSnapshot!.entries[0].values.cost).toBe(20)
  })

  it.each(['prepared', 'attempted', 'unknown'] as const)('rejects unresolved slot state %s without replacing the original', async slot => {
    const input = await fixture({ slot }), original = canonicalOwnerLocal(input); await rejectAck(input)
    expect(canonicalOwnerLocal(input)).toBe(original)
  })

  it.each([
    ['matchedResult.requestId', 'synthetic-wrong-0001'], ['matchedResult.requestHash', '0'.repeat(64)],
    ['matchedResult.source', 'cached'], ['matchedResult.status', '200'], ['matchedResult.status', -0],
    ['minimumObservedRevision', -0], ['minimumObservedRevision', true], ['minimumObservedRevision', 3],
    ['id', 'synthetic-original-0001'], ['id', 'synthetic-adoption-0001'], ['id', 'synthetic-link-0001'],
    ['id', new String('synthetic-ack-0001')], ['id', 'synthetic-ack-0001\n'],
    ['expected.local.outbox.entry.state', 'conflict'], ['expected.local.receiptCount', 201],
  ])('rejects ACK identity/response/head/preimage drift %s', async (path, value) => {
    const input = await fixture(); replace(input, path as string, value); await rejectAck(input)
  })

  it('requires complete D to cover B, original success and the observed revision floor, not just posted records', async () => {
    const input = await fixture(), oldD = copy(input); replace(oldD, 'completeBaseline', baseline([record()]))
    await rejectAck(oldD)
    const headOnly = copy(input); replace(headOnly, 'completeBaseline', baseline([record()], 2)); await rejectAck(headOnly)
    const manual = record({ key: 'asset:synthetic', kind: 'manual_asset', field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
      values: { name: 'manual', cls: '现金', value: 0, note: null } })
    const missing = await fixture({ base: baseline([record(), manual]), cloud: baseline([changed()]) }); await rejectAck(missing)
    const high = await fixture({ cloud: baseline([changed(record(), 30, 4)]), }), allowed = { ...high, minimumObservedRevision: 4 }
    expect((await previewOwnerWorkspaceAck(TARGET, allowed)).baseD!.pulledRevision).toBe(4)
    await rejectAck({ ...allowed, minimumObservedRevision: 5 })
  })

  it('restores SHA-bound original raw bytes before interpreting JSON, and rechecks packet id/base/intention', async () => {
    for (const field of ['bytes', 'id', 'revision', 'intent']) {
      const input = await fixture(), pending = input.expected.sync.pending!, raw = JSON.parse(pending.rawBody)
      if (field === 'id') raw.request_id = 'synthetic-other-0001'
      if (field === 'revision') raw.expected_revision = 0
      if (field === 'intent') raw.operations[0].changes.cost = 9
      const rawBody = field === 'bytes' ? pending.rawBody + ' ' : JSON.stringify(raw), requestHash = field === 'bytes' ? pending.requestHash : sha(rawBody)
      replace(input, 'expected.sync.pending.rawBody', rawBody); replace(input, 'expected.sync.pending.requestHash', requestHash)
      replace(input, 'expected.local.outbox.entry.rawBody', rawBody); replace(input, 'expected.local.outbox.entry.requestHash', requestHash)
      replace(input, 'matchedResult.requestHash', requestHash)
      await rejectAck(input)
    }
  })

  it.each([
    'null', '{}', '{"revision":2,"revision":2,"records":[]}', '{"revision":2,"records":[],"extra":true}',
    '{"state":"missing"}', '{"state":"unknown"}', 'x'.repeat(128 * 1024 + 1), '\ud800',
  ])('rejects malformed/bounded raw responses without disclosing private source (case %#)', async rawBody => {
    const input = await fixture(); replace(input, 'matchedResult.rawBody', rawBody); await rejectAck(input)
  })

  it('binds the derived plan, whole expected state and minimum revision rather than treating a hash as authentication', async () => {
    const input = await fixture(), request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input)
    for (const [path, value] of [['hash', '0'.repeat(64)], ['minimumObservedRevision', 1], ['expected.local.receiptCount', 4]] as const) {
      const changed = copy(request); replace(changed, path, value)
      await expect(rehydrateOwnerWorkspaceAckCloudRequest(TARGET, changed)).rejects.toMatchObject({ code: 'invalid_ack' })
    }
    const high = await buildOwnerWorkspaceAckCloudRequest(TARGET, { ...input, minimumObservedRevision: 1 })
    expect(high.hash).not.toBe(request.hash)
    expect(await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, high)).toMatchObject({ request: high })
  })

  it('returns exactly the one reconstructed preview whose derived postimage was hashed', async () => {
    const input = await fixture(), request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input),
      planner = vi.spyOn(ackPlanner, 'buildOwnerWorkspaceAckPreview')
    const restored = await rehydrateOwnerWorkspaceAckCloudRequest(TARGET, request)
    expect(planner).toHaveBeenCalledTimes(1)
    expect(restored.preview).toBe(planner.mock.results[0].value)
    frozen(restored)
  })

  it('rejects an originally sealed request if a changed derived postimage would otherwise reuse its input', async () => {
    const input = await fixture(), request = await buildOwnerWorkspaceAckCloudRequest(TARGET, input), original = ackPlanner.buildOwnerWorkspaceAckPreview
    vi.spyOn(ackPlanner, 'buildOwnerWorkspaceAckPreview').mockImplementation(value => {
      const result = original(value)
      return { ...result, changedKeys: [...result.changedKeys, KEY] }
    })
    await expect(rehydrateOwnerWorkspaceAckCloudRequest(TARGET, request)).rejects.toMatchObject({ code: 'invalid_ack' })
  })

  it.each(['accessor', 'symbol', 'hidden', 'prototype'])('rehydration rejects a non-closed sealed envelope (%s)', async kind => {
    const input = copy(await buildOwnerWorkspaceAckCloudRequest(TARGET, await fixture())), getter = vi.fn(() => '0'.repeat(64))
    if (kind === 'accessor') Object.defineProperty(input, 'hash', { enumerable: true, get: getter })
    if (kind === 'symbol') Object.defineProperty(input, Symbol('hidden'), { value: true })
    if (kind === 'hidden') Object.defineProperty(input, 'hidden', { value: true })
    if (kind === 'prototype') Object.setPrototypeOf(input, { inherited: true })
    await expect(rehydrateOwnerWorkspaceAckCloudRequest(TARGET, input)).rejects.toMatchObject({ code: 'invalid_ack' })
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    'id', 'expected', 'matchedResult', 'completeBaseline', 'minimumObservedRevision', 'resolutions',
    'matchedResult.rawBody', 'matchedResult.requestHash', 'expected.local.sync', 'expected.sync.pending.rawBody',
    'completeBaseline.records', 'completeBaseline.records.0.values.cost',
  ])('rejects an ACK accessor without invoking %s', async path => {
    const input = await fixture(), parts = path.split('.'), key = parts.pop()!, getter = vi.fn(() => PRIVATE)
    Object.defineProperty(at(input, parts.join('.')), key, { enumerable: true, get: getter })
    await rejectAck(input); expect(getter).not.toHaveBeenCalled()
  })

  it.each(['sparse', 'accessor', 'symbol', 'hidden', 'prototype', 'extra'])('rejects non-native/closed resolution arrays (%s)', async kind => {
    const input = await fixture({ conflict: true }), resolution = { key: KEY, field: 'cost', choice: 'local' }, rows: unknown[] = [resolution], getter = vi.fn(() => resolution)
    if (kind === 'sparse') delete rows[0]
    if (kind === 'accessor') Object.defineProperty(rows, '0', { enumerable: true, get: getter })
    if (kind === 'symbol') Object.defineProperty(rows, Symbol('hidden'), { value: true })
    if (kind === 'hidden') Object.defineProperty(rows, 'hidden', { value: true })
    if (kind === 'prototype') Object.setPrototypeOf(rows, Object.create(Array.prototype))
    if (kind === 'extra') Object.assign(resolution, { extra: true })
    replace(input, 'resolutions', rows); await rejectAck(input); expect(getter).not.toHaveBeenCalled()
  })

  it('fails hash availability closed and never substitutes a guessed request hash', async () => {
    const input = await fixture(); vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error(PRIVATE)) } })
    // Original packet restoration may reject first; neither path may return a request.
    await expect(buildOwnerWorkspaceAckCloudRequest(TARGET, input)).rejects.toMatchObject({ message: 'Owner workspace managed operation rejected' })
  })

  it.each([2, 3])('reports actual key/envelope SHA failure without exposing crypto errors (digest #%s)', async failureAt => {
    const input = await fixture(), original = webcrypto.subtle.digest.bind(webcrypto.subtle)
    let calls = 0
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn((...args: Parameters<typeof original>) => {
      if (++calls === failureAt) return Promise.reject(new Error(PRIVATE))
      return original(...args)
    }) } })
    await rejectAck(input, 'hash_unavailable')
    expect(calls).toBe(failureAt)
  })
})
