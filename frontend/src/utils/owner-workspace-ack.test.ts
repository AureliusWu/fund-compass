import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import {
  buildOwnerSyncRequest, restoreOwnerSyncRequest,
  type OwnerSyncRecord, type OwnerSyncWriteResult,
} from './ownerSyncContract'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from './owner-cloud-import'
import { planOwnerWorkspaceCloudIntent } from './owner-workspace-sync'
import {
  buildOwnerWorkspaceAckPreview,
  type OwnerWorkspaceAckInput, type OwnerWorkspaceAckResolution,
} from './owner-workspace-ack'

const KEY = '000001::synthetic-account', OTHER = '000002::synthetic-other', PRIVATE = 'synthetic-private-never-echo'
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function record(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic-fund', shares: 0, cost: null, target_weight: null }, ...patch } as OwnerSyncRecord
}
function manual(patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return record({ key: 'asset:synthetic', kind: 'manual_asset',
    field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: 'synthetic-manual', cls: '现金', value: 0, note: null }, ...patch })
}
function entry(source: OwnerSyncRecord = record(), patch: Record<string, unknown> = {}): OwnerWorkspaceEntry {
  return { key: source.key, kind: source.kind, deleted: source.deleted, values: { ...source.values }, local_pending: true,
    ...patch } as unknown as OwnerWorkspaceEntry
}
function baseline(records: readonly OwnerSyncRecord[] = [record()], pulledRevision = Math.max(0, ...records.map(row => row.record_revision))): OwnerSyncBaseline {
  return { pulledRevision, records }
}
function snapshot(entries: readonly OwnerWorkspaceEntry[]): OwnerWorkspaceSnapshot {
  return { localVersion: 7, entries, legacy: { sourceKey: 'sinan_watchlist_v2', raw: PRIVATE } }
}
function changed(source: OwnerSyncRecord, changes: Record<string, unknown>, at = 2,
  patch: Record<string, unknown> = {}): OwnerSyncRecord {
  return record({ ...source, record_revision: at, values: { ...source.values, ...changes },
    field_revisions: { ...source.field_revisions, ...Object.fromEntries(Object.keys(changes).map(key => [key, at])) }, ...patch })
}
function digest(key: string): string { return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16) }
function rawConflict(items: readonly { key: string; fields: readonly string[] }[]): string {
  return JSON.stringify({ error: { code: 'sync_conflict', message: '同步冲突，请保留本地草稿并重新核对。' },
    conflicts: items.map(row => ({ key_digest: digest(row.key), fields: [...row.fields].sort() })) })
}
async function fixture(options: {
  base?: OwnerSyncBaseline; local?: OwnerWorkspaceSnapshot; cloud?: OwnerSyncBaseline;
  success?: OwnerSyncWriteResult; conflicts?: readonly { key: string; fields: readonly string[] }[];
  receipt?: boolean; resolutions?: readonly OwnerWorkspaceAckResolution[]; observed?: number;
} = {}): Promise<OwnerWorkspaceAckInput> {
  const before = record(), base = options.base ?? baseline([before]),
    local = options.local ?? snapshot([entry(before, { values: { ...before.values, cost: 8 } })])
  const intent = planOwnerWorkspaceCloudIntent(base, local)
  expect(intent.issues).toEqual([])
  const built = await buildOwnerSyncRequest({ request_id: 'synthetic-request-0001', expected_revision: base.pulledRevision, operations: intent.operations })
  const packet = await restoreOwnerSyncRequest(built.rawBody, built.requestHash)
  const success = options.success ?? { revision: 2, records: [changed(before, { cost: 8 })] }
  const status = options.conflicts ? 409 : 200
  const result = options.conflicts ? JSON.parse(rawConflict(options.conflicts)) : success
  return { base, localSnapshot: local, packet,
    matchedResult: { source: options.receipt ? 'receipt' : 'write', requestId: packet.request.request_id,
      requestHash: packet.requestHash, status: options.receipt ? 200 : status,
      rawBody: JSON.stringify(options.receipt ? { state: 'matched', status, result } : result) },
    completeBaseline: options.cloud ?? baseline(success.records, success.revision), minimumObservedRevision: options.observed ?? 0,
    keyDigests: packet.request.operations.map(operation => ({ key: operation.key, digest: digest(operation.key) })),
    resolutions: options.resolutions ?? [] }
}
function invalid(input: unknown, code?: string) {
  const result = buildOwnerWorkspaceAckPreview(input)
  expect(result.issues.length).toBeGreaterThan(0)
  if (code) expect(result.issues[0].code).toBe(code)
  expect(result).toMatchObject({ outcome: null, nextSnapshot: null, baseD: null, conflicts: [], rows: [], changedKeys: [] })
  expect(JSON.stringify(result)).not.toContain(PRIVATE)
  return result
}
function frozen(input: unknown): void {
  if (input && typeof input === 'object') { expect(Object.isFrozen(input)).toBe(true); Object.values(input).forEach(frozen) }
}

describe('complete-D matched 200 acknowledgement', () => {
  it.each([false, true])('accepts raw matched write/receipt, retains full manual/tombstone D and pending (receipt=%s)', async receipt => {
    const before = record(), post = changed(before, { cost: 8 }), remoteOnly = record({ key: OTHER,
      record_revision: 2, lifecycle_revision: 2, field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }),
      tombstone = manual({ key: 'asset:deleted', deleted: true }),
      input = await fixture({ base: baseline([before, manual(), tombstone]), receipt,
        cloud: baseline([post, manual(), tombstone, remoteOnly]), success: { revision: 2, records: [post] } })
    const original = JSON.stringify(input), result = buildOwnerWorkspaceAckPreview(input)
    expect(result.issues).toEqual([])
    expect(result.outcome).toBe('success')
    expect(result.conflicts).toEqual([])
    expect(result.baseD).toEqual(input.completeBaseline)
    expect(result.excludedManualAssets).toBe(2)
    expect(result.nextSnapshot).toEqual({ ...input.localSnapshot, entries: [input.localSnapshot.entries[0], entry(remoteOnly)] })
    expect(result.nextSnapshot!.entries.every(row => row.local_pending)).toBe(true)
    expect(result.changedKeys).toEqual([OTHER])
    expect(result.rows[0]).toMatchObject({ key: OTHER, before: null, fields: ['lifecycle'] })
    expect(JSON.stringify(input)).toBe(original)
    frozen(result)
    expect(Object.isFrozen(input)).toBe(false)
  })

  it('consumes submitted local intent and adopts later D instead of replaying L or POST partial records', async () => {
    const post = changed(record(), { cost: 8 }), later = changed(post, { cost: 20, name: 'new-device' }, 4),
      input = await fixture({ success: { revision: 2, records: [post] }, cloud: baseline([later], 4), observed: 3 })
    const result = buildOwnerWorkspaceAckPreview(input)
    expect(result.issues).toEqual([])
    expect(result.nextSnapshot!.entries[0].values).toEqual(later.values)
    expect(result.baseD!.pulledRevision).toBe(4)
    expect(result.changedKeys).toEqual([KEY])
    expect(result.rows[0].fields).toEqual(['name', 'cost'])
    expect(result.nextSnapshot!.localVersion).toBe(7)
    expect(result.nextSnapshot!.legacy).toEqual(input.localSnapshot.legacy)
  })

  it('accepts real zero/null and preserves local negative zero without inventing zero-sign intent', async () => {
    const before = record({ values: { name: 'synthetic-fund', shares: -0, cost: -0, target_weight: null } }),
      local = snapshot([entry(before, { values: { ...before.values, cost: null, target_weight: -0 } })]),
      post = changed(before, { cost: null, target_weight: 0 }),
      input = await fixture({ base: baseline([before]), local, success: { revision: 2, records: [post] }, cloud: baseline([post]) })
    const result = buildOwnerWorkspaceAckPreview(input)
    expect(result.issues).toEqual([])
    expect(result.nextSnapshot!.entries[0].values.cost).toBeNull()
    expect(Object.is(result.nextSnapshot!.entries[0].values.shares, -0)).toBe(true)
    expect(Object.is(result.nextSnapshot!.entries[0].values.target_weight, -0)).toBe(true)
    expect(Object.is(result.baseD!.records[0].values.target_weight, 0)).toBe(true)
    expect(result.changedKeys).toEqual([])
  })

  it('preserves an original unmapped tombstone and explicitly resolves a new cloud identity collision', async () => {
    const gone = entry(record({ key: OTHER }), { deleted: true }), local = snapshot([
      entry(record(), { values: { ...record().values, cost: 8 } }), gone]),
      input = await fixture({ local })
    expect(buildOwnerWorkspaceAckPreview(input).nextSnapshot!.entries[1]).toEqual(gone)
    const collision = { ...input, completeBaseline: baseline([changed(record(), { cost: 8 }), record({ key: OTHER,
      record_revision: 2, lifecycle_revision: 2, field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } })]) }
    const unresolved = buildOwnerWorkspaceAckPreview(collision)
    expect(unresolved.nextSnapshot).toBeNull()
    expect(unresolved.conflicts).toMatchObject([{ key: OTHER, field: 'lifecycle', reason: 'creation_collision' }])
    const chosen = buildOwnerWorkspaceAckPreview({ ...collision, resolutions: [{ key: OTHER, field: 'lifecycle', choice: 'local' }] })
    expect(chosen.nextSnapshot!.entries[1].deleted).toBe(true)
  })

  it('handles full deletes, holding/watch lifecycle changes and creates without claiming business confirmation', async () => {
    const before = record(), created = record({ key: OTHER, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }),
      deleted = record({ deleted: true, record_revision: 2, lifecycle_revision: 2 }),
      local = snapshot([entry(before, { deleted: true }), entry(created)]),
      input = await fixture({ local, success: { revision: 2, records: [deleted, created] }, cloud: baseline([deleted, created]) })
    const result = buildOwnerWorkspaceAckPreview(input)
    expect(result.issues).toEqual([])
    expect(result.nextSnapshot!.entries).toEqual(local.entries)
    const watch = record({ kind: 'watch', record_revision: 2, lifecycle_revision: 2,
      values: { name: 'synthetic-fund', shares: null, cost: null, target_weight: null },
      field_revisions: { name: 1, shares: 2, cost: 1, target_weight: 1 } })
    const converted = buildOwnerWorkspaceAckPreview(await fixture({ local: snapshot([entry(watch)]),
      success: { revision: 2, records: [watch] }, cloud: baseline([watch]) }))
    expect(converted.issues).toEqual([])
    expect(converted.nextSnapshot!.entries[0].kind).toBe('watch')
  })

  it('keeps existing unknown holding shares null and records the original pending=false before-image', async () => {
    const before = record({ values: { ...record().values, shares: null } }),
      local = snapshot([entry(before, { local_pending: false, values: { ...before.values, cost: 0 } })]),
      post = changed(before, { cost: 0 }), input = await fixture({ base: baseline([before]), local,
        success: { revision: 2, records: [post] }, cloud: baseline([post]) }), result = buildOwnerWorkspaceAckPreview(input)
    expect(result.issues).toEqual([])
    expect(result.nextSnapshot!.entries[0]).toMatchObject({ values: { shares: null, cost: 0 }, local_pending: true })
    expect(result.rows[0].before!.local_pending).toBe(false)
    expect(result.rows[0].after!.local_pending).toBe(true)
    expect(result.rows[0].fields).toEqual([])
  })

  it('does not accept a complete-looking D that omits a newly created, successful original operation', async () => {
    const created = record({ key: OTHER, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }),
      input = await fixture({ base: baseline([]), local: snapshot([entry(created)]),
        success: { revision: 2, records: [created] }, cloud: baseline([created]) })
    invalid({ ...input, completeBaseline: baseline([manual({ record_revision: 3 })]) }, 'missing_cloud_record')
  })

  it('rejects a kind-change result that pretends an unchanged field was modified after the full B guard', async () => {
    const watch = record({ kind: 'watch', record_revision: 2, lifecycle_revision: 2,
      values: { name: 'synthetic-fund', shares: null, cost: null, target_weight: null },
      field_revisions: { name: 1, shares: 2, cost: 1, target_weight: 1 } }),
      input = await fixture({ local: snapshot([entry(watch)]), success: { revision: 2, records: [watch] }, cloud: baseline([watch]) }),
      wrong = { ...watch, field_revisions: { ...watch.field_revisions, name: 2 } }
    invalid({ ...input, matchedResult: { ...input.matchedResult,
      rawBody: JSON.stringify({ revision: 2, records: [wrong] }) }, completeBaseline: baseline([wrong]) }, 'result_mismatch')
  })

  it.each(['missing', 'extra', 'wrong-value', 'wrong-kind', 'wrong-stamp', 'old-revision'] as const)('rejects noncovering/mismatched partial result: %s', async mode => {
    const input = await fixture(), result = JSON.parse(input.matchedResult.rawBody)
    if (mode === 'missing') result.records = []
    if (mode === 'extra') result.records.push(record({ key: OTHER }))
    if (mode === 'wrong-value') result.records[0].values.cost = 9
    if (mode === 'wrong-kind') result.records[0].kind = 'watch'
    if (mode === 'wrong-stamp') result.records[0].field_revisions.cost = 1
    if (mode === 'old-revision') { result.revision = 1; result.records = [record()] }
    invalid({ ...input, matchedResult: { ...input.matchedResult, rawBody: JSON.stringify(result) } })
  })
})

describe('409 actual B/L/D three-way merge and explicit choices', () => {
  it('merges independent field/account edits while preserving unsent local intent against B', async () => {
    const before = record(), other = record({ key: OTHER }),
      local = snapshot([entry(before, { values: { ...before.values, cost: 8 } }), entry(other, { values: { ...other.values, name: 'my-name' } })]),
      cloud = baseline([changed(before, { shares: 3 }, 2), changed(other, { name: 'remote-name' }, 3)]),
      input = await fixture({ base: baseline([before, other]), local, cloud, conflicts: [{ key: OTHER, fields: ['name'] }] })
    const unresolved = buildOwnerWorkspaceAckPreview(input)
    expect(unresolved.issues).toEqual([])
    expect(unresolved.conflicts).toMatchObject([{ key: OTHER, field: 'name', reason: 'field_changed' }])
    expect(unresolved.nextSnapshot).toBeNull()
    expect(unresolved.baseD).toEqual(cloud)
    const result = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: OTHER, field: 'name', choice: 'cloud' }] })
    expect(result.nextSnapshot!.entries[0].values).toMatchObject({ shares: 3, cost: 8 })
    expect(result.nextSnapshot!.entries[1].values.name).toBe('remote-name')
    expect(planOwnerWorkspaceCloudIntent(result.baseD, result.nextSnapshot).operations).toMatchObject([
      { key: KEY, changes: { cost: 8 }, base_values: { cost: null } },
    ])
  })

  it.each(['local', 'cloud'] as const)('same edited field requires explicit %s resolution; other cloud fields survive', async choice => {
    const cloud = baseline([changed(record(), { cost: 12, name: 'remote' })]),
      input = await fixture({ cloud, conflicts: [{ key: KEY, fields: ['cost'] }] }),
      preview = buildOwnerWorkspaceAckPreview(input)
    expect(preview.conflicts).toMatchObject([{ key: KEY, field: 'cost', reason: 'field_changed', localAllowed: true, choice: null }])
    const result = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'cost', choice }] })
    expect(result.issues).toEqual([])
    expect(result.nextSnapshot!.entries[0].values).toMatchObject({ cost: choice === 'local' ? 8 : 12, name: 'remote' })
    expect(result.conflicts[0].choice).toBe(choice)
  })

  it('field ABA and an already-known original server conflict cannot silently become a fresh baseline', async () => {
    const aba = changed(record(), { cost: null }), input = await fixture({ cloud: baseline([aba]), conflicts: [{ key: KEY, fields: ['cost'] }] })
    expect(buildOwnerWorkspaceAckPreview(input).conflicts).toMatchObject([{ field: 'cost', reason: 'field_aba' }])
    const nowLooksUnchanged = { ...input, completeBaseline: baseline([record()]) }
    const unresolved = buildOwnerWorkspaceAckPreview(nowLooksUnchanged)
    expect(unresolved.issues).toEqual([])
    expect(unresolved.conflicts).toMatchObject([{ field: 'cost', reason: 'server_conflict' }])
    expect(unresolved.nextSnapshot).toBeNull()
    expect(buildOwnerWorkspaceAckPreview({ ...nowLooksUnchanged, resolutions: [{ key: KEY, field: 'cost', choice: 'local' }] }).nextSnapshot!.entries[0].values.cost).toBe(8)
  })

  it('lifecycle ABA cannot be reduced to current same-kind/same-deleted field merge', async () => {
    const aba = record({ record_revision: 3, lifecycle_revision: 3 }),
      input = await fixture({ cloud: baseline([aba]), conflicts: [{ key: KEY, fields: ['deleted'] }] })
    const preview = buildOwnerWorkspaceAckPreview(input)
    expect(preview.conflicts).toMatchObject([{ field: 'lifecycle', reason: 'lifecycle_aba' }])
    expect(buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'cost', choice: 'local' }] }).issues).not.toEqual([])
    const explicit = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'lifecycle', choice: 'local' }] })
    expect(explicit.nextSnapshot!.entries[0].values.cost).toBe(8)
  })

  it('cloud tombstone never revives silently or through an illegal local choice', async () => {
    const cloud = baseline([record({ deleted: true, record_revision: 2, lifecycle_revision: 2 })]),
      input = await fixture({ cloud, conflicts: [{ key: KEY, fields: ['deleted'] }] })
    const preview = buildOwnerWorkspaceAckPreview(input)
    expect(preview.conflicts).toMatchObject([{ field: 'lifecycle', reason: 'cloud_tombstone', localAllowed: false }])
    invalid({ ...input, resolutions: [{ key: KEY, field: 'lifecycle', choice: 'local' }] }, 'invalid_resolution')
    const chosen = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'lifecycle', choice: 'cloud' }] })
    expect(chosen.nextSnapshot!.entries[0].deleted).toBe(true)
    expect(chosen.nextSnapshot!.entries[0].local_pending).toBe(true)
  })

  it('local delete vs remote edit is one full lifecycle decision, not partial finance deletion', async () => {
    const input = await fixture({ local: snapshot([entry(record(), { deleted: true })]),
      cloud: baseline([changed(record(), { shares: 4 })]), conflicts: [{ key: KEY, fields: ['record_revision', 'shares'] }] })
    const preview = buildOwnerWorkspaceAckPreview(input)
    expect(preview.conflicts).toMatchObject([{ field: 'lifecycle', reason: 'lifecycle_changed' }])
    const local = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'lifecycle', choice: 'local' }] })
    expect(local.nextSnapshot!.entries[0]).toMatchObject({ deleted: true, values: { shares: 0 } })
    const cloud = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'lifecycle', choice: 'cloud' }] })
    expect(cloud.nextSnapshot!.entries[0]).toMatchObject({ deleted: false, values: { shares: 4 } })
  })

  it('keeps a same-value cloud edit explicitly conflicting rather than conflating intent consumption with 409', async () => {
    const input = await fixture({ cloud: baseline([changed(record(), { cost: 8 })]), conflicts: [{ key: KEY, fields: ['cost'] }] }),
      result = buildOwnerWorkspaceAckPreview(input)
    expect(result.outcome).toBe('conflict')
    expect(result.conflicts).toMatchObject([{ field: 'cost', reason: 'field_changed', choice: null }])
    expect(result.nextSnapshot).toBeNull()
  })

  it('a cloud-only field ABA does not manufacture a conflict with a different local field', async () => {
    const second = record({ key: OTHER }), local = snapshot([entry(record(), { values: { ...record().values, cost: 8 } }),
      entry(second, { values: { ...second.values, cost: 3 } })]),
      input = await fixture({ base: baseline([record(), second]), local,
        cloud: baseline([changed(record(), { shares: 0 }, 2), changed(second, { cost: 4 }, 3)]),
        conflicts: [{ key: OTHER, fields: ['cost'] }], resolutions: [{ key: OTHER, field: 'cost', choice: 'cloud' }] }),
      result = buildOwnerWorkspaceAckPreview(input)
    expect(result.issues).toEqual([])
    expect(result.conflicts.map(row => row.key)).toEqual([OTHER])
    expect(result.nextSnapshot!.entries[0].values).toMatchObject({ shares: 0, cost: 8 })
  })

  it('groups an old-account tombstone + fresh-account creation atomically on 409', async () => {
    const fresh = '000001::synthetic-renamed', before = record(), newEntry = entry(before, { key: fresh }),
      local = snapshot([entry(before, { deleted: true }), newEntry]),
      input = await fixture({ local, cloud: baseline([changed(before, { shares: 4 })]), conflicts: [{ key: KEY, fields: ['record_revision'] }] })
    const unresolved = buildOwnerWorkspaceAckPreview(input)
    expect(unresolved.conflicts).toMatchObject([{ key: KEY, field: 'rename', reason: 'rename_atomic', groupKeys: [KEY, fresh] }])
    const localChoice = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'rename', choice: 'local' }] })
    expect(localChoice.nextSnapshot!.entries).toEqual(local.entries)
    const cloudChoice = buildOwnerWorkspaceAckPreview({ ...input, resolutions: [{ key: KEY, field: 'rename', choice: 'cloud' }] })
    expect(cloudChoice.nextSnapshot!.entries).toEqual([entry(changed(before, { shares: 4 })), { ...newEntry, deleted: true }])
    expect(planOwnerWorkspaceCloudIntent(cloudChoice.baseD, cloudChoice.nextSnapshot)).toEqual({ operations: [], issues: [] })
    expect(cloudChoice.changedKeys).toEqual([KEY, fresh])
    invalid({ ...input, resolutions: [{ key: KEY, field: 'lifecycle', choice: 'cloud' }] }, 'invalid_resolution')
  })

  it('refuses a rename-local choice that would resurrect any group tombstone', async () => {
    const fresh = '000001::synthetic-renamed', before = record(),
      remoteFresh = record({ key: fresh, deleted: true, record_revision: 2, lifecycle_revision: 2,
        field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 } }),
      input = await fixture({ local: snapshot([entry(before, { deleted: true }), entry(before, { key: fresh })]),
        cloud: baseline([before, remoteFresh]), conflicts: [{ key: fresh, fields: ['deleted'] }] })
    expect(buildOwnerWorkspaceAckPreview(input).conflicts).toMatchObject([{ field: 'rename', localAllowed: false }])
    invalid({ ...input, resolutions: [{ key: KEY, field: 'rename', choice: 'local' }] }, 'invalid_resolution')
  })
})

describe('closed provenance-shaped input and monotonic full snapshots', () => {
  it.each(['wrong-id', 'wrong-hash', 'extra', 'duplicate-json', 'idempotency', 'unknown-receipt', 'failure'] as const)('rejects unbound/unknown/malformed raw outcome: %s', async mode => {
    const input = await fixture(), matched = { ...input.matchedResult }
    if (mode === 'wrong-id') matched.requestId = 'another-request-001'
    if (mode === 'wrong-hash') matched.requestHash = 'f'.repeat(64)
    if (mode === 'extra') matched.rawBody = JSON.stringify({ ...JSON.parse(matched.rawBody), private: PRIVATE })
    if (mode === 'duplicate-json') matched.rawBody = '{"revision":2,"revision":2,"records":[]}'
    if (mode === 'idempotency') { matched.status = 409; matched.rawBody = JSON.stringify({ error: { code: 'idempotency_conflict', message: '请求标识已用于不同的同步请求。' } }) }
    if (mode === 'unknown-receipt') { matched.source = 'receipt'; matched.status = 404; matched.rawBody = '{"state":"unknown","error":"sync_result_unknown"}' }
    if (mode === 'failure') { matched.status = 503; matched.rawBody = '{"error":{"code":"storage_unavailable","message":"同步存储暂不可用。"}}' }
    invalid({ ...input, matchedResult: matched })
  })

  it.each(['subset', 'altered-intent', 'noncanonical', 'wrong-length', 'extra-packet', 'wrong-base'] as const)('rejects arbitrary/trimmed/not-original B→L packet: %s', async mode => {
    const input = await fixture(), packet = { ...input.packet }
    if (mode === 'subset') {
      const local = snapshot([...input.localSnapshot.entries, entry(record({ key: OTHER }), { values: { ...record().values, cost: 2 } })])
      invalid({ ...input, localSnapshot: local }, 'intent_mismatch'); return
    }
    if (mode === 'altered-intent') packet.request = { ...packet.request, operations: [{ ...packet.request.operations[0], changes: { cost: 9 } }] }
    if (mode === 'noncanonical') { packet.rawBody += ' '; packet.byteLength++ }
    if (mode === 'wrong-length') packet.byteLength++
    if (mode === 'extra-packet') { invalid({ ...input, packet: { ...packet, private: PRIVATE } }, 'invalid_packet'); return }
    if (mode === 'wrong-base') {
      const anotherBase = baseline([record({ record_revision: 2 })])
      invalid({ ...input, base: anotherBase }, 'intent_mismatch'); return
    }
    invalid({ ...input, packet }, 'invalid_packet')
  })

  it('rejects dropped B records, partial D, regressed D, observed/result floors and impossible backdated fields', async () => {
    const before = record(), other = record({ key: OTHER }),
      input = await fixture({ base: baseline([before, other]),
        local: snapshot([entry(before, { values: { ...before.values, cost: 8 } }), entry(other)]),
        cloud: baseline([changed(before, { cost: 8 }), other]) })
    invalid({ ...input, completeBaseline: baseline([changed(before, { cost: 8 })]) }, 'missing_cloud_record')
    invalid({ ...input, localSnapshot: snapshot([input.localSnapshot.entries[0]]) }, 'intent_mismatch')
    invalid({ ...input, completeBaseline: baseline([before, other]) }, 'baseline_regression')
    invalid({ ...input, minimumObservedRevision: 3 }, 'baseline_regression')
    const bad = changed(before, { cost: 8 }, 2, { field_revisions: before.field_revisions })
    invalid({ ...input, completeBaseline: baseline([bad, other]) }, 'baseline_regression')
    invalid({ ...input, completeBaseline: { pulledRevision: 3, records: input.completeBaseline.records } }, 'invalid_baseline')
  })

  it.each(['success', 'conflict'] as const)('previews an authoritative explicit fresh cloud revival without redefining backend semantics during unrelated %s ACK', async outcome => {
    // A different device can explicitly revive from the tombstone with complete
    // fresh values. Applying that authenticated full D is not this old device
    // silently uploading stale values; ACK still needs the complete row preview
    // and the coordinator's separate explicit commit confirmation.
    const deleted = record({ deleted: true }), other = record({ key: OTHER }),
      local = snapshot([entry(deleted), entry(other, { values: { ...other.values, cost: 8 } })]),
      post = changed(other, { cost: 8 }), observedRevive = record({ record_revision: 3, lifecycle_revision: 3,
        values: { name: 'freshly-revived-cloud-fund', shares: 4, cost: 0, target_weight: null },
        field_revisions: { name: 3, shares: 3, cost: 3, target_weight: 3 } }),
      input = await fixture({ base: baseline([deleted, other]), local,
        success: { revision: 2, records: [post] },
        conflicts: outcome === 'conflict' ? [{ key: OTHER, fields: ['cost'] }] : undefined,
        cloud: baseline([observedRevive, outcome === 'conflict' ? changed(other, { cost: 12 }) : post]) })
    if (outcome === 'conflict') {
      const unresolved = buildOwnerWorkspaceAckPreview(input)
      expect(unresolved.issues).toEqual([])
      expect(unresolved.nextSnapshot).toBeNull()
      expect(unresolved.conflicts).toMatchObject([{ key: OTHER, field: 'cost', choice: null }])
    }
    const result = buildOwnerWorkspaceAckPreview({ ...input,
      resolutions: outcome === 'conflict' ? [{ key: OTHER, field: 'cost', choice: 'local' }] : [] })
    expect(result.issues).toEqual([])
    expect(result.rows.find(row => row.key === KEY)).toMatchObject({
      before: { deleted: true, values: deleted.values },
      after: { deleted: false, values: observedRevive.values, local_pending: true }, fields: ['lifecycle', 'name', 'shares', 'cost'],
    })
    expect(result.baseD).toEqual(input.completeBaseline)
    expect(result.nextSnapshot!.entries.every(row => row.local_pending)).toBe(true)
    expect(result.nextSnapshot!.entries.find(row => row.key === OTHER)!.values.cost).toBe(8)
    const remaining = planOwnerWorkspaceCloudIntent(result.baseD, result.nextSnapshot)
    expect(remaining.issues).toEqual([])
    expect(remaining.operations).toEqual(outcome === 'success' ? [] : [{ key: OTHER, kind: 'holding', deleted: false,
      changes: { cost: 8 }, base_values: { kind: 'holding', deleted: false, cost: 12 } }])
  })

  it.each(['missing', 'duplicate-key', 'duplicate-digest', 'newline', 'extra', 'unknown-server', 'duplicate-server', 'unguarded-field', 'keyed-global', 'keyed-record-revision'] as const)('requires one-to-one closed original key/digest association: %s', async mode => {
    const other = record({ key: OTHER }), local = snapshot([entry(record(), { values: { ...record().values, cost: 8 } }),
      entry(other, { values: { ...other.values, cost: 3 } })]),
      input = await fixture({ base: baseline([record(), other]), local,
        cloud: baseline([changed(record(), { cost: 12 }), other]), conflicts: [{ key: KEY, fields: ['cost'] }] })
    let keyDigests: unknown = input.keyDigests, matched = { ...input.matchedResult }
    if (mode === 'missing') keyDigests = input.keyDigests.slice(1)
    if (mode === 'duplicate-key') keyDigests = [input.keyDigests[0], input.keyDigests[0]]
    if (mode === 'duplicate-digest') keyDigests = [input.keyDigests[0], { ...input.keyDigests[1], digest: input.keyDigests[0].digest }]
    if (mode === 'newline') keyDigests = input.keyDigests.map(row => ({ ...row, digest: row.digest + '\n' }))
    if (mode === 'extra') keyDigests = [{ ...input.keyDigests[0], private: PRIVATE }, input.keyDigests[1]]
    if (mode === 'unknown-server') matched.rawBody = rawConflict([{ key: '000003::unknown', fields: ['cost'] }])
    if (mode === 'duplicate-server') matched.rawBody = rawConflict([{ key: KEY, fields: ['cost'] }, { key: KEY, fields: ['cost'] }])
    if (mode === 'unguarded-field') matched.rawBody = rawConflict([{ key: KEY, fields: ['name'] }])
    if (mode === 'keyed-global') matched.rawBody = rawConflict([{ key: KEY, fields: ['expected_revision'] }])
    if (mode === 'keyed-record-revision') matched.rawBody = rawConflict([{ key: KEY, fields: ['record_revision'] }])
    invalid({ ...input, keyDigests, matchedResult: matched }, mode === 'newline' ? 'invalid_digests' : undefined)
  })

  it('rejects accessors/exotic/sparse DTOs without reading their getters or freezing original input', async () => {
    const input = await fixture(); let calls = 0
    invalid({ ...input, get base() { calls++; return input.base } }, 'invalid_input')
    invalid({ ...input, packet: { ...input.packet, get rawBody() { calls++; return input.packet.rawBody } } }, 'invalid_packet')
    invalid({ ...input, resolutions: Array(1) }, 'invalid_resolution')
    invalid({ ...input, keyDigests: Object.assign([...input.keyDigests], { private: PRIVATE }) }, 'invalid_digests')
    invalid(Object.assign(Object.create({}), input), 'invalid_input')
    invalid({ ...input, [Symbol('private')]: PRIVATE }, 'invalid_input')
    expect(calls).toBe(0)
    expect(Object.isFrozen(input.base.records[0].values)).toBe(false)
  })

  it.each([true, -0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid observed revision %s', async minimumObservedRevision => {
    invalid({ ...await fixture(), minimumObservedRevision }, 'invalid_input')
  })

  it('rejects duplicate/extraneous/forbidden resolutions and ignores no arbitrary parsed result object', async () => {
    const input = await fixture({ cloud: baseline([changed(record(), { cost: 12 })]), conflicts: [{ key: KEY, fields: ['cost'] }] }),
      resolution = { key: KEY, field: 'cost', choice: 'local' }
    invalid({ ...input, resolutions: [resolution, resolution] }, 'invalid_resolution')
    invalid({ ...input, resolutions: [{ ...resolution, field: 'name' }] }, 'invalid_resolution')
    invalid({ ...input, resolutions: [{ ...resolution, choice: 'merge' }] }, 'invalid_resolution')
    invalid({ ...input, matchedResult: { kind: 'conflict', status: 409, result: JSON.parse(input.matchedResult.rawBody) } }, 'invalid_result')
  })
})
