import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import type { OwnerSyncWatchSnapshot } from '@/stores/watchlist'
import { buildOwnerSyncRequest, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { buildOwnerSyncPreview } from './owner-sync-preview'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
function local(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: '000001', name: '合成基金', account: '', position_kind: 'holding', shares: 0,
    cost: null, target_weight: null, updated_at: '2026-10-15T00:00:00Z', local_pending: true, ...overrides }
}
function snapshot(entries: Record<string, unknown>[]): OwnerSyncWatchSnapshot {
  const memory = JSON.stringify(entries)
  return { entries, raw: memory, memory, generation: 1 } as unknown as OwnerSyncWatchSnapshot
}
function record(overrides: Partial<OwnerSyncRecord> = {}): OwnerSyncRecord {
  return { key: '000001::', kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成基金', shares: 0, cost: null, target_weight: null }, ...overrides }
}
function baseline(records: OwnerSyncRecord[] = [], pulledRevision = records.length ? 1 : 0): OwnerSyncBaseline {
  return { records, pulledRevision }
}

describe('pure explicitly scoped fund/account Owner preview', () => {
  it('preserves a real zero holding, null finance and separate accounts without mutating inputs', () => {
    const source = snapshot([local({ account: ' 支付宝 ', cost: 0, target_weight: 0 }),
      local({ account: '券商', position_kind: 'watch', shares: null })])
    const original = JSON.stringify(source), preview = buildOwnerSyncPreview(source, baseline())
    expect(preview.issues).toEqual([])
    expect(preview.operations).toEqual([
      { key: '000001::支付宝', kind: 'holding', deleted: false,
        changes: { name: '合成基金', shares: 0, cost: 0, target_weight: 0 } },
      { key: '000001::券商', kind: 'watch', deleted: false,
        changes: { name: '合成基金', shares: null, cost: null, target_weight: null } },
    ])
    expect(JSON.stringify(source)).toBe(original)
    expect(Object.isFrozen(preview)).toBe(true)
    expect(Object.isFrozen(preview.operations)).toBe(true)
    expect(Object.isFrozen(preview.rows[0]!.after.values)).toBe(true)
    expect(Reflect.set(preview.rows[0]!.after.values, 'shares', 42)).toBe(false)
    expect(preview.rows[0]).toMatchObject({ code: '000001', account: '支付宝', action: 'create' })
  })

  it('does not replace omitted local fields with null/zero or resend equal fields', () => {
    const cloud = baseline([record({ values: { name: '云端名称', shares: 5, cost: 3, target_weight: 40 } })])
    const omitted = local({ shares: 5 })
    delete omitted.name; delete omitted.cost; delete omitted.target_weight
    expect(buildOwnerSyncPreview(snapshot([omitted]), cloud).operations).toEqual([])
    const explicit = buildOwnerSyncPreview(snapshot([{ ...omitted, cost: null }]), cloud)
    expect(explicit.issues).toEqual([])
    expect(explicit.operations).toEqual([{ key: '000001::', kind: 'holding', deleted: false, changes: { cost: null } }])
    expect(explicit.rows[0]!.after.values).toEqual({ name: '云端名称', shares: 5, cost: null, target_weight: 40 })
  })

  it('keeps old-key deletion plus new-account creation in one batch and does not upload local hints', () => {
    const old = record({ key: '000001::旧账户' })
    const input = snapshot([local({ account: '旧账户', deleted: true }), local({ account: '新账户' })])
    const preview = buildOwnerSyncPreview(input, baseline([old]))
    expect(preview.issues).toEqual([])
    expect(preview.operations.map(row => [row.key, row.deleted])).toEqual([['000001::旧账户', true], ['000001::新账户', false]])
    expect(preview.rows.map(row => row.action)).toEqual(['delete', 'create'])
    expect(preview.operations[0]).not.toHaveProperty('changes')
    expect(preview.operations.every(row => !('base_values' in row))).toBe(true)
    expect(JSON.stringify(preview.operations)).not.toMatch(/local_pending|updated_at|account|position_kind/)
    expect(input.entries[0]!.deleted).toBe(true)
  })

  it('never deletes cloud-only rows or clears local tombstones that need no remote DELETE', () => {
    const input = snapshot([local({ code: '000003', deleted: true })])
    const cloud = baseline([record(), record({ key: '000002::', deleted: true })])
    const original = JSON.stringify(input)
    expect(buildOwnerSyncPreview(input, cloud)).toEqual({ rows: [], operations: [], issues: [] })
    expect(JSON.stringify(input)).toBe(original)
    expect(buildOwnerSyncPreview(snapshot([local({ deleted: true })]), baseline([record({ deleted: true })])).operations).toEqual([])
  })

  it('blocks the entire batch instead of reviving an old local copy over a cloud tombstone', () => {
    const preview = buildOwnerSyncPreview(snapshot([local({ code: '000002' }), local()]), baseline([record({ deleted: true })]))
    expect(preview.issues).toContainEqual({ code: 'cloud_tombstone', key: '000001::' })
    expect(preview.rows.some(row => row.key === '000002::')).toBe(true)
    expect(preview.operations).toEqual([])
  })

  it('changes explicit kind using fresh finance, not an old holding merge', () => {
    const cloud = baseline([record({ values: { name: '合成基金', shares: 100, cost: 2, target_weight: 40 } })])
    const input = local({ position_kind: 'watch', shares: null })
    delete input.cost; delete input.target_weight
    const preview = buildOwnerSyncPreview(snapshot([input]), cloud)
    expect(preview.issues).toEqual([])
    expect(preview.operations[0]).toMatchObject({ kind: 'watch', changes: { shares: null, cost: null, target_weight: null } })
    expect(preview.rows[0]!.action).toBe('kind_change')
    expect(preview.rows[0]!.fields).toContain('kind')
  })

  it.each([
    [{ position_kind: undefined, shares: undefined }, 'ambiguous_kind'],
    [{ position_kind: undefined, shares: 0 }, 'ambiguous_kind'],
    [{ position_kind: 'holding', shares: null }, 'missing_value'],
    [{ name: undefined }, 'missing_value'],
    [{ position_kind: 'watch', shares: 1 }, 'missing_value'],
    [{ private_future_field: 'synthetic-secret-not-in-result' }, 'invalid_local_record'],
    [{ id: '000002::' }, 'invalid_local_record'],
    [{ shares: -1 }, 'invalid_local_record'],
    [{ target_weight: 101 }, 'invalid_local_record'],
    [{ shares: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_operation'],
  ] as const)('blocks every operation for unsafe source %j', (patch, code) => {
    const preview = buildOwnerSyncPreview(snapshot([local({ code: '000002' }), local(patch)]), baseline())
    expect(preview.issues.some(issue => issue.code === code)).toBe(true)
    expect(preview.operations).toEqual([])
    expect(JSON.stringify(preview)).not.toContain('synthetic-secret-not-in-result')
  })

  it('can classify a historical positive position, but never guesses a zero/unknown kind', () => {
    const preview = buildOwnerSyncPreview(snapshot([local({ position_kind: undefined, shares: 5 })]), baseline())
    expect(preview.issues).toEqual([])
    expect(preview.operations[0]!.kind).toBe('holding')
  })

  it('rejects duplicate normalized account identity and does not split >200 operations', () => {
    const duplicate = buildOwnerSyncPreview(snapshot([local({ account: 'A' }), local({ account: ' A ' })]), baseline())
    expect(duplicate.issues).toContainEqual({ code: 'duplicate_key', key: '000001::A' })
    expect(duplicate.operations).toEqual([])
    const many = buildOwnerSyncPreview(snapshot(Array.from({ length: 201 }, (_, index) => local({ code: String(index + 1).padStart(6, '0') }))), baseline())
    expect(many.issues).toContainEqual({ code: 'too_many_operations', key: null })
    expect(many.operations).toEqual([])
  })

  it('leaves the exact 128KiB packet check to prepare/request construction, without a preview hash', async () => {
    const preview = buildOwnerSyncPreview(snapshot(Array.from({ length: 200 }, (_, index) =>
      local({ code: String(index + 1).padStart(6, '0'), name: '中'.repeat(200) }))), baseline())
    expect(preview.issues).toEqual([])
    expect(preview.operations).toHaveLength(200)
    await expect(buildOwnerSyncRequest({ request_id: 'synthetic-preview-bound-0001', expected_revision: 0,
      operations: preview.operations })).rejects.toMatchObject({ code: 'invalid_sync_request' })
  })

  it('rejects invalid/duplicate baselines and mismatched local snapshot memory', () => {
    for (const cloud of [baseline([record(), record()]), baseline([record({ record_revision: 2 })], 1)]) {
      expect(buildOwnerSyncPreview(snapshot([local()]), cloud)).toMatchObject({ operations: [], issues: [{ code: 'invalid_baseline' }] })
    }
    const input = snapshot([local()])
    expect(buildOwnerSyncPreview({ ...input, memory: '[]' }, baseline())).toMatchObject({ operations: [], issues: [{ code: 'invalid_local_record' }] })
  })

  it('does not read a source getter or invoke IO/hash/legacy storage', () => {
    const forbidden = vi.fn(() => { throw new Error('forbidden IO') })
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
    vi.stubGlobal('indexedDB', { open: forbidden })
    vi.stubGlobal('crypto', { subtle: { digest: forbidden } })
    const valid = buildOwnerSyncPreview(snapshot([local()]), baseline())
    expect(valid.issues).toEqual([])
    const input = snapshot([local()]), getter = vi.fn(() => 'synthetic-private-getter')
    Object.defineProperty(input.entries[0], 'name', { enumerable: true, get: getter })
    expect(buildOwnerSyncPreview(input, baseline()).operations).toEqual([])
    expect(getter).not.toHaveBeenCalled()
    expect(forbidden).not.toHaveBeenCalled()
  })
})
