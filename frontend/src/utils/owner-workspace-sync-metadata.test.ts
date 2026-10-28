import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncRecord } from './ownerSyncContract'
import {
  emptyOwnerWorkspaceSyncMetadata, validateOwnerWorkspaceSyncMetadata,
  type OwnerWorkspaceSyncMetadata, type OwnerWorkspaceSyncMetadataContext,
} from './owner-workspace-sync-metadata'

const TARGET = 'a'.repeat(64)
const ADOPTION_ID = 'synthetic-adoption-0001'
const ADOPTION_HASH = 'b'.repeat(64)
const RAW = '{"expected_revision":3,"operations":[{"changes":{"name":"合成"},"deleted":false,"key":"000001::","kind":"watch"}],"request_id":"synthetic-request-0001"}'
function fund(key = '000001::', revision = 1): OwnerSyncRecord {
  return { key, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: revision, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成基金', shares: 0, cost: null, target_weight: 0 } }
}
function manual(key = 'asset:synthetic-1', revision = 3): OwnerSyncRecord {
  return { key, kind: 'manual_asset', deleted: true, record_revision: revision, lifecycle_revision: revision,
    field_revisions: { name: revision, cls: revision, value: revision, note: revision },
    values: { name: '合成手工资产', cls: '现金', value: 0, note: null } }
}
function linked(): OwnerWorkspaceSyncMetadata {
  return { schema: 'owner-workspace-sync-1', targetFingerprint: TARGET, epoch: 1,
    base: { pulledRevision: 3, records: [fund(), { ...fund('000002::', 2), kind: 'watch', deleted: true,
      values: { name: '合成关注', shares: null, cost: null, target_weight: null } }, manual()] },
    pending: null, recentReceipt: { id: 'synthetic-link-0001', hash: 'c'.repeat(64), operation: 'link',
      syncEpoch: 1, localVersion: 4, outboxVersion: 2 } }
}
function prepared(): OwnerWorkspaceSyncMetadata {
  return { ...linked(), epoch: 2, pending: { requestId: 'synthetic-request-0001', requestHash: 'd'.repeat(64),
    rawBody: RAW, preimageHash: 'e'.repeat(64), preparationHash: 'f'.repeat(64),
    adoptionId: ADOPTION_ID, adoptionHash: ADOPTION_HASH,
    localVersion: 4, preparedOutboxVersion: 6, baseRevision: 3 } }
}
function context(value: OwnerWorkspaceSyncMetadata = prepared()): OwnerWorkspaceSyncMetadataContext {
  return { snapshot: { localVersion: 4, entries: [], legacy: null },
    metadata: { schema: 'owner-workspace-local-1', adoption: { id: ADOPTION_ID, hash: ADOPTION_HASH,
      backupSha256: '9'.repeat(64), sourceArchive: { sourceKey: null, v1Raw: null, v2Raw: null }, localVersion: 4 },
      displayTimes: [], recentEdit: null, restoredArchives: [] },
    outbox: { version: 7, entry: value.pending === null ? null : { schema: 'owner-sync-outbox-1', state: 'prepared',
      rawBody: value.pending.rawBody, requestHash: value.pending.requestHash } } }
}
function rejected(value: unknown, target = TARGET, current?: OwnerWorkspaceSyncMetadataContext, code = 'invalid_metadata') {
  expect(() => validateOwnerWorkspaceSyncMetadata(value, target, current)).toThrow(expect.objectContaining({ code }))
}
function mutate<T>(value: T, action: (copy: any) => void): T {
  const copy = structuredClone(value)
  action(copy)
  return copy
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('pure guarded workspace sync metadata', () => {
  it('retains explicit ack for the current empty epoch and for the next preparation', () => {
    const ack = { ...linked(), epoch: 3, recentReceipt: { ...linked().recentReceipt!, operation: 'ack' as const,
      syncEpoch: 3, outboxVersion: 5 } }
    expect(validateOwnerWorkspaceSyncMetadata(ack, TARGET, context(ack))).toEqual(ack)
    const next = { ...ack, epoch: 4, pending: prepared().pending }
    expect(validateOwnerWorkspaceSyncMetadata(next, TARGET, context(next))).toEqual(next)
    rejected({ ...ack, recentReceipt: { ...ack.recentReceipt, syncEpoch: 2 } })
    rejected({ ...next, recentReceipt: { ...ack.recentReceipt, syncEpoch: 4 } })
  })

  it('creates only a frozen unlinked epoch0 with no cloud, packet or receipt claims', () => {
    const empty = emptyOwnerWorkspaceSyncMetadata(TARGET)
    expect(empty).toEqual({ schema: 'owner-workspace-sync-1', targetFingerprint: TARGET,
      epoch: 0, base: null, pending: null, recentReceipt: null })
    expect(Object.isFrozen(empty)).toBe(true)
    expect(validateOwnerWorkspaceSyncMetadata(empty, TARGET, context(empty))).toEqual(empty)
  })

  it('retains full cloud manual assets, tombstones, zero/null and every revision without confirming them', () => {
    const input = prepared(), current = context(input)
    const result = validateOwnerWorkspaceSyncMetadata(input, TARGET, current)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
    expect(result.base).not.toBe(input.base)
    expect(result.base!.records[0].values).toEqual({ name: '合成基金', shares: 0, cost: null, target_weight: 0 })
    expect(result.base!.records[1]).toMatchObject({ deleted: true, values: { shares: null } })
    expect(result.base!.records[2]).toEqual(manual())
    expect(Object.keys(result).sort()).toEqual(['base', 'epoch', 'pending', 'recentReceipt', 'schema', 'targetFingerprint'])
    expect(Object.isFrozen(result.base!.records)).toBe(true)
    expect(Object.isFrozen(result.base!.records[0].field_revisions)).toBe(true)
    expect(Object.isFrozen(result.base!.records[2].values)).toBe(true)
    expect(Object.isFrozen(result.pending)).toBe(true)
    expect(Object.isFrozen(result.recentReceipt)).toBe(true)
    ;(input.base!.records[0].values as any).name = 'later input mutation'
    ;(input.pending as any).preimageHash = '0'.repeat(64)
    expect(result.base!.records[0].values.name).toBe('合成基金')
    expect(result.pending!.preimageHash).toBe('e'.repeat(64))
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(current)).toBe(false)
  })

  it('permits the complete empty head0 base but requires a positive local link receipt', () => {
    const value = { ...linked(), base: { pulledRevision: 0, records: [] } }
    expect(validateOwnerWorkspaceSyncMetadata(value, TARGET, context(value)).base).toEqual({ pulledRevision: 0, records: [] })
    const pending = { ...value, epoch: 2, pending: { ...prepared().pending!, baseRevision: 0 } }
    expect(validateOwnerWorkspaceSyncMetadata(pending, TARGET, context(pending)).pending!.baseRevision).toBe(0)
  })

  it('allows confirmed/conflict/unknown slot states without treating any as a cloud acknowledgement', () => {
    for (const state of ['prepared', 'attempted', 'unknown', 'confirmed', 'conflict'] as const) {
      const value = prepared(), current = context(value)
      const result = validateOwnerWorkspaceSyncMetadata(value, TARGET,
        { ...current, outbox: { ...current.outbox, entry: { ...current.outbox.entry!, state } } })
      expect(result).toEqual(value)
      expect(result.recentReceipt!.operation).toBe('link')
      expect(result.pending).not.toBeNull()
    }
  })

  it('retains the original preparation-envelope hash separately from packet hash and preimage hash', () => {
    const result = validateOwnerWorkspaceSyncMetadata(prepared(), TARGET)
    expect(new Set([result.pending!.preparationHash, result.pending!.requestHash, result.pending!.preimageHash]).size).toBe(3)
    rejected(mutate(prepared(), row => { delete row.pending.preparationHash }))
  })

  it('accepts a later cancel receipt with an empty slot while preserving the original common base', () => {
    const value = { ...linked(), epoch: 3, recentReceipt: { ...linked().recentReceipt!, operation: 'cancel' as const,
      syncEpoch: 3, outboxVersion: 7 } }
    expect(validateOwnerWorkspaceSyncMetadata(value, TARGET, context(value))).toEqual(value)
  })

  it('uses the current outbox version as an upper bound, not as a false exact prepare version', () => {
    const value = prepared(), current = context(value)
    expect(validateOwnerWorkspaceSyncMetadata(value, TARGET, current).pending!.preparedOutboxVersion).toBe(6)
    rejected(value, TARGET, { ...current, outbox: { ...current.outbox, version: 5 } })
  })

  it.each([
    ['pending before first preparation epoch', (row: any) => { row.epoch = 1 }],
    ['pending keeps a same-epoch receipt', (row: any) => { row.recentReceipt.syncEpoch = 2 }],
    ['pending skips an unobserved sync epoch', (row: any) => { row.epoch = 3 }],
    ['prepared slot does not advance past receipt', (row: any) => { row.pending.preparedOutboxVersion = 2 }],
    ['prepared slot predates receipt', (row: any) => { row.pending.preparedOutboxVersion = 1 }],
    ['preparation local image predates receipt', (row: any) => { row.pending.localVersion = 3 }],
    ['empty slot retains an older epoch receipt', (row: any) => { row.pending = null }],
  ])('rejects field-valid but unreachable link/prepare/cancel metadata: %s', (_label, action) => {
    rejected(mutate(prepared(), action))
  })

  it('accepts prepare after a real later cancel receipt without inventing a new receipt or changing cloud head', () => {
    const value = { ...prepared(), epoch: 4, recentReceipt: { ...linked().recentReceipt!, operation: 'cancel' as const,
      syncEpoch: 3, outboxVersion: 7 }, pending: { ...prepared().pending!, preparedOutboxVersion: 9 } }
    const current = context(value)
    const result = validateOwnerWorkspaceSyncMetadata(value, TARGET, { ...current, outbox: { ...current.outbox, version: 10 } })
    expect(result).toEqual(value)
    expect(result.base!.pulledRevision).toBe(3)
    expect(result.recentReceipt!.syncEpoch).toBe(result.epoch - 1)
  })

  it('does no crypto, clock, storage, network or credential IO while validating opaque bindings', () => {
    const external = vi.fn(() => { throw new Error('synthetic forbidden external call') })
    vi.stubGlobal('crypto', { subtle: { digest: external }, getRandomValues: external })
    vi.stubGlobal('fetch', external)
    vi.stubGlobal('indexedDB', { open: external })
    vi.stubGlobal('localStorage', { getItem: external, setItem: external })
    vi.spyOn(Date, 'now').mockImplementation(external)
    expect(validateOwnerWorkspaceSyncMetadata(prepared(), TARGET, context())).toEqual(prepared())
    expect(external).not.toHaveBeenCalled()
  })

  it('is explicitly shape-only: raw JSON id/hash validation must occur via async restore before the transaction', () => {
    const value = mutate(prepared(), row => { row.pending.rawBody = '{"request_id":"different-0001","request_id":"duplicate-0001"}' })
    // No JSON.parse fallback or hash claim is made by this synchronous codec.
    expect(validateOwnerWorkspaceSyncMetadata(value, TARGET, context(value))).toEqual(value)
  })

  it.each([
    ['wrong schema', (row: any) => { row.schema = 'owner-workspace-sync-2' }],
    ['wrong target', (row: any) => { row.targetFingerprint = 'b'.repeat(64) }],
    ['base without epoch', (row: any) => { row.epoch = 0 }],
    ['base without receipt', (row: any) => { row.recentReceipt = null }],
    ['pending without base', (row: any) => { row.base = null }],
    ['future receipt epoch', (row: any) => { row.recentReceipt.syncEpoch = 3 }],
    ['wrong receipt operation', (row: any) => { row.recentReceipt.operation = 'remote-confirmed' }],
    ['old cloud base', (row: any) => { row.pending.baseRevision = 2 }],
    ['extra private field', (row: any) => { row.ownerToken = 'synthetic-never-real' }],
    ['partial base', (row: any) => { row.base.records.pop() }],
    ['duplicate base record', (row: any) => { row.base.records.push(row.base.records[0]) }],
  ])('rejects unreachable or unclosed metadata: %s', (_label, action) => rejected(mutate(prepared(), action)))

  it.each(['epoch', 'pending', 'recentReceipt'] as const)('unlinked base cannot carry %s state', field => {
    const value = { ...linked(), base: null, epoch: 0, recentReceipt: null } as any
    value[field] = field === 'epoch' ? 1 : field === 'pending' ? prepared().pending : linked().recentReceipt
    rejected(value)
  })

  const counterPaths = ['epoch', 'pending.localVersion', 'pending.preparedOutboxVersion', 'pending.baseRevision',
    'recentReceipt.syncEpoch', 'recentReceipt.localVersion', 'recentReceipt.outboxVersion'] as const
  it.each(counterPaths.flatMap(path => [-0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, true, '1', new Number(1)]
    .map((value, index) => [path, value, index] as const)))('rejects non-native or unsafe counter %s/%s', (path, value) => {
    rejected(mutate(prepared(), row => {
      const parts = path.split('.')
      if (parts.length === 1) row[parts[0]] = value
      else row[parts[0]][parts[1]] = value
    }))
  })

  it.each(['pending.localVersion', 'pending.preparedOutboxVersion', 'recentReceipt.syncEpoch',
    'recentReceipt.localVersion', 'recentReceipt.outboxVersion'])('requires positive reachable %s', path => {
    rejected(mutate(prepared(), row => { const [group, field] = path.split('.'); row[group][field] = 0 }))
  })

  it.each(['targetFingerprint', 'pending.requestHash', 'pending.preimageHash', 'pending.preparationHash',
    'pending.adoptionHash', 'recentReceipt.hash'])('requires exact lowercase SHA64 in %s', path => {
    for (const value of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64) + '\n', new String('a'.repeat(64)), false]) {
      rejected(mutate(prepared(), row => { const parts = path.split('.');
        if (parts.length === 1) row[parts[0]] = value
        else row[parts[0]][parts[1]] = value
      }))
    }
  })

  it.each(['pending.requestId', 'pending.adoptionId', 'recentReceipt.id'])('retains strict original id grammar in %s', path => {
    for (const value of ['short-1', 'a'.repeat(129), '_invalid-0001', 'contains space', '中文-id-0001', 'valid-id-0001\n', new String('valid-id-0001')]) {
      rejected(mutate(prepared(), row => { const [group, field] = path.split('.'); row[group][field] = value }))
    }
    for (const value of ['a'.repeat(8), 'a'.repeat(128)]) {
      const changed = mutate(prepared(), row => { const [group, field] = path.split('.'); row[group][field] = value })
      expect(validateOwnerWorkspaceSyncMetadata(changed, TARGET)).toEqual(changed)
    }
  })

  it.each(['snapshot.localVersion', 'adoption.id', 'adoption.hash', 'adoption.absent', 'slot.empty',
    'slot.body', 'slot.hash', 'receipt.localVersion', 'receipt.outboxVersion'])('binds the complete current context: %s', field => {
    const value = prepared(), current: any = structuredClone(context(value))
    if (field === 'snapshot.localVersion') {
      current.snapshot.localVersion = 5; current.metadata.adoption.localVersion = 5
    } else if (field === 'adoption.id') current.metadata.adoption.id = 'different-adoption-0001'
    else if (field === 'adoption.hash') current.metadata.adoption.hash = '0'.repeat(64)
    else if (field === 'adoption.absent') current.metadata.adoption = null
    else if (field === 'slot.empty') current.outbox.entry = null
    else if (field === 'slot.body') current.outbox.entry.rawBody += ' '
    else if (field === 'slot.hash') current.outbox.entry.requestHash = '0'.repeat(64)
    else if (field === 'receipt.localVersion') (value.recentReceipt as any).localVersion = 5
    else (value.recentReceipt as any).outboxVersion = 8
    rejected(value, TARGET, current)
  })

  it('rejects nonempty slots without pending and a linked base without actual local adoption', () => {
    rejected(linked(), TARGET, context(prepared()))
    const current = context(linked())
    rejected(linked(), TARGET, { ...current, metadata: { ...current.metadata, adoption: null } })
    const empty = emptyOwnerWorkspaceSyncMetadata(TARGET)
    rejected(empty, TARGET, context(prepared()))
  })

  it.each([-0, -1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, false, '7'])('rejects malformed current outbox version %s', version => {
    const current = context()
    rejected(prepared(), TARGET, { ...current, outbox: { ...current.outbox, version } } as any)
  })

  it.each(['', '\ud800', '\udc00', 'x'.repeat(128 * 1024 + 1), '中'.repeat(50_000)])('bounds and validates raw body scalars %#', rawBody => {
    const value = mutate(prepared(), row => { row.pending.rawBody = rawBody })
    rejected(value, TARGET, undefined, rawBody.length > 128 * 1024 || new TextEncoder().encode(rawBody).byteLength > 128 * 1024
      ? 'capacity_exceeded' : 'invalid_metadata')
  })

  it('retains exact bytes at the ASCII128KiB boundary and valid supplementary Unicode', () => {
    for (const rawBody of ['x'.repeat(128 * 1024), '😀']) {
      const value = mutate(prepared(), row => { row.pending.rawBody = rawBody })
      expect(validateOwnerWorkspaceSyncMetadata(value, TARGET, context(value)).pending!.rawBody).toBe(rawBody)
    }
  })

  it('preserves the full baseline2MiB cap without trimming manual records or tombstones', () => {
    const records = Array.from({ length: 1100 }, (_, index) => ({ ...manual('asset:bounded-' + index, index + 1),
      values: { ...manual().values, note: 'x'.repeat(2000) } }))
    const value = { ...linked(), base: { pulledRevision: records.length, records } }
    rejected(value, TARGET, undefined, 'capacity_exceeded')
  })

  it.each(['root', 'pending', 'receipt', 'context', 'outbox', 'entry'] as const)('rejects accessors without invoking them in %s', level => {
    const value: any = prepared(), current: any = context(value)
    const [object, key] = level === 'root' ? [value, 'epoch'] : level === 'pending' ? [value.pending, 'requestId']
      : level === 'receipt' ? [value.recentReceipt, 'id'] : level === 'context' ? [current, 'snapshot']
        : level === 'outbox' ? [current.outbox, 'version'] : [current.outbox.entry, 'rawBody']
    const getter = vi.fn(() => { throw new Error('synthetic getter must remain uncalled') })
    Object.defineProperty(object, key, { get: getter, enumerable: true })
    rejected(value, TARGET, current)
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['root', 'pending', 'receipt', 'context', 'outbox', 'entry'] as const)('rejects hidden/symbol/prototype fields in %s', level => {
    for (const attack of ['hidden', 'symbol', 'prototype']) {
      const value: any = prepared(), current: any = context(value)
      const object = level === 'root' ? value : level === 'pending' ? value.pending : level === 'receipt' ? value.recentReceipt
        : level === 'context' ? current : level === 'outbox' ? current.outbox : current.outbox.entry
      if (attack === 'hidden') Object.defineProperty(object, 'private', { value: true, enumerable: false })
      else if (attack === 'symbol') object[Symbol('private')] = true
      else Object.setPrototypeOf(object, { inherited: 'private' })
      rejected(value, TARGET, current)
    }
  })

  it.each(['hole', 'getter', 'hidden-index', 'symbol', 'prototype'])('delegates strict array checks for complete base records: %s', attack => {
    const value: any = prepared(), rows = value.base.records
    const getter = vi.fn(() => { throw new Error('synthetic record getter must remain uncalled') })
    if (attack === 'hole') delete rows[0]
    else if (attack === 'getter') Object.defineProperty(rows, '0', { get: getter, enumerable: true })
    else if (attack === 'hidden-index') Object.defineProperty(rows, '0', { value: rows[0], enumerable: false })
    else if (attack === 'symbol') rows[Symbol('private')] = true
    else Object.setPrototypeOf(rows, Object.create(Array.prototype))
    rejected(value)
    expect(getter).not.toHaveBeenCalled()
  })

  it('accepts ordinary null-prototype data without retaining any input object', () => {
    const value = Object.assign(Object.create(null), linked())
    const result = validateOwnerWorkspaceSyncMetadata(value, TARGET)
    expect(result).toEqual(linked())
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(result.base).not.toBe(value.base)
  })
})
