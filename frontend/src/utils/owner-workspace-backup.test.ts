import { describe, expect, it } from 'vitest'
import {
  buildOwnerLegacyWorkspaceBackup, buildOwnerWorkspaceBackup, restoreOwnerWorkspaceBackup,
  validateOwnerWorkspaceBackup, emptyOwnerWorkspaceLocalMetadata, previewOwnerWorkspaceRestore,
  canonicalOwnerLocal, type OwnerWorkspaceSourceArchive,
} from './owner-workspace-backup'
import type { OwnerWorkspaceEntry, OwnerWorkspaceSnapshot } from './owner-cloud-import'

const row = { code: '000001', name: '合成基金', account: '账户一', position_kind: 'holding', shares: 0,
  cost: null, target_weight: 0, updated_at: '2026-10-20T00:00:00Z', local_pending: true }
const archive = (rows: unknown[] = [row]): OwnerWorkspaceSourceArchive => ({ sourceKey: 'sinan_watchlist_v2',
  v1Raw: 'unselected malformed raw is retained exactly; not generic secret redaction', v2Raw: JSON.stringify(rows) })
async function sha(raw: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(part => part.toString(16).padStart(2, '0')).join('')
}
describe('strict local workspace backup codec', () => {
  it('binds both raw archives, actual nullable timestamps, tombstones, pending and zero/null in two hashes', async () => {
    const built = await buildOwnerLegacyWorkspaceBackup(archive([row, { ...row, code: '000002', position_kind: 'watch', shares: null, deleted: true }]))
    const checked = await restoreOwnerWorkspaceBackup(built.raw, built.sha256)
    expect(checked.sourceArchive).toEqual(archive([row, { ...row, code: '000002', position_kind: 'watch', shares: null, deleted: true }]))
    expect(checked.entries[0].values).toEqual({ name: row.name, shares: 0, cost: null, target_weight: 0 })
    expect(checked.entries[1]).toMatchObject({ deleted: true, local_pending: true, values: { shares: null } })
    expect(checked.displayTimes.map(value => value.updated_at)).toEqual([row.updated_at, row.updated_at])
    const changed = { ...checked, sourceArchive: { ...checked.sourceArchive, v1Raw: 'changed' } }
    await expect(validateOwnerWorkspaceBackup(changed)).rejects.toMatchObject({ code: 'hash_mismatch' })
    await expect(restoreOwnerWorkspaceBackup(built.raw + '\n', built.sha256)).rejects.toMatchObject({ code: 'hash_mismatch' })
    expect(Object.isFrozen(checked.sourceArchive)).toBe(true)
  })

  it('supports actual no-slot empty adoption without inventing raw/source/time', async () => {
    const built = await buildOwnerLegacyWorkspaceBackup({ sourceKey: null, v1Raw: null, v2Raw: null })
    expect((await restoreOwnerWorkspaceBackup(built.raw, built.sha256))).toMatchObject({ entries: [], displayTimes: [],
      sourceArchive: { sourceKey: null, v1Raw: null, v2Raw: null } })
  })

  it.each([
    [{ ...row, name: undefined }, 'missing_name'],
    [{ ...row, position_kind: undefined, shares: 0 }, 'ambiguous_kind'],
    [{ ...row, position_kind: undefined, shares: null }, 'ambiguous_kind'],
  ])('rejects incomplete/ambiguous real legacy conversion %#', async (value, code) => {
    await expect(buildOwnerLegacyWorkspaceBackup(archive([value]))).rejects.toMatchObject({ code })
  })

  it('rejects source selection substitution and duplicate legacy keys', async () => {
    await expect(buildOwnerLegacyWorkspaceBackup({ ...archive(), sourceKey: 'sinan_watchlist_v1' })).rejects.toMatchObject({ code: 'invalid_backup' })
    await expect(buildOwnerLegacyWorkspaceBackup(archive([row, row]))).rejects.toMatchObject({ code: 'invalid_legacy' })
    await expect(buildOwnerLegacyWorkspaceBackup({ ...archive(), v2Raw: '[{"code":"000001","code":"000002"}]' })).rejects.toMatchObject({ code: 'invalid_legacy' })
  })

  it.each([
    (raw: string) => raw.replace('"format":', '"format":"duplicate","format":'),
    (raw: string) => raw.replace('"format":', '"\\u0066ormat":"duplicate","format":'),
    (raw: string) => raw.replace('"shares":0', '"shares":9007199254740993'),
    (raw: string) => raw.replace('合成基金', '\\ud800'),
    (raw: string) => raw.replace('"format":', '"cloud_revision":1,"format":'),
  ])('rejects duplicate/escaped keys, unsafe integer, surrogate and unclosed fields %#', async mutate => {
    const built = await buildOwnerLegacyWorkspaceBackup(archive()), raw = mutate(built.raw)
    await expect(restoreOwnerWorkspaceBackup(raw, await sha(raw))).rejects.toMatchObject({ code: 'invalid_backup' })
  })

  it('has only entry/time/archive business fields, not outbox/auth/version fields', async () => {
    const built = await buildOwnerLegacyWorkspaceBackup(archive())
    expect(Object.keys(built.envelope).sort()).toEqual(['displayTimes', 'entries', 'entriesSha256', 'format', 'restoredArchives', 'sourceArchive'])
    const snapshot: OwnerWorkspaceSnapshot = { localVersion: 1, entries: built.envelope.entries,
      legacy: { sourceKey: 'sinan_watchlist_v2', raw: archive().v2Raw } }
    const metadata = { ...emptyOwnerWorkspaceLocalMetadata(snapshot), displayTimes: [{ key: built.envelope.entries[0].key, updated_at: null }],
      adoption: { id: 'synthetic-adopt-0001', hash: 'a'.repeat(64), backupSha256: built.sha256,
        sourceArchive: archive(), localVersion: 1 } }
    const exported = await buildOwnerWorkspaceBackup({ snapshot, metadata })
    expect(exported.envelope.displayTimes[0].updated_at).toBeNull()
    expect(exported.envelope.entries).toEqual(snapshot.entries)
    expect(canonicalOwnerLocal(exported.envelope)).toBe(exported.raw)
  })

  it('previews all backup rows; same-key differences including tombstone/time conflict, empty never clears', async () => {
    const built = await buildOwnerLegacyWorkspaceBackup(archive()), current = built.envelope.entries[0]
    const snapshot: OwnerWorkspaceSnapshot = { localVersion: 1, entries: [{ ...current, deleted: true }], legacy: null }
    const state = { snapshot, metadata: emptyOwnerWorkspaceLocalMetadata(snapshot) }
    expect(previewOwnerWorkspaceRestore(state, built.envelope)).toMatchObject({ added: 0, conflicts: 1, canApply: false })
    const incoming = { ...built.envelope, entries: [current, { ...current, key: '000002::账户一' } as OwnerWorkspaceEntry],
      displayTimes: [...built.envelope.displayTimes, { key: '000002::账户一', updated_at: null }] }
    expect(previewOwnerWorkspaceRestore(state, incoming).rows.map(value => value.action)).toEqual(['conflict', 'add'])
    const empty = await buildOwnerLegacyWorkspaceBackup({ sourceKey: null, v1Raw: null, v2Raw: null })
    expect(previewOwnerWorkspaceRestore(state, empty.envelope)).toEqual({ rows: [], added: 0, noops: 0, conflicts: 0, canApply: false })
  })
})
