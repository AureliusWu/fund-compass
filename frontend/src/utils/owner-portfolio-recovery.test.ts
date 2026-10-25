/** Real adopted/v4/v5 workspace primitives with synthetic records. Decoding a
 * file is not browser download, disaster restore, cloud or old-PWA evidence. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceRestoreLocalRequest, buildOwnerWorkspaceLinkCloudRequest,
  buildOwnerWorkspaceEditPortfolioRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard, type OwnerWorkspaceLocalState,
} from '@/stores/owner-workspace'
import { buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest } from '@/stores/owner-workspace-portfolio-upgrade'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from './owner-workspace-backup'
import { parseOwnerBusinessJson } from './owner-legacy-seed'
import { restoreOwnerWorkspaceRecoveryBackup } from './owner-workspace-recovery'
import {
  OWNER_PORTFOLIO_RECOVERY_FORMAT, OWNER_PORTFOLIO_RECOVERY_MAX_BYTES,
  buildOwnerPortfolioRecoveryBackup, restoreOwnerPortfolioRecoveryBackup, validateOwnerPortfolioRecoveryBackup,
} from './owner-portfolio-recovery'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'

const TARGET = '4'.repeat(64), KEY = '510300::备份合成账户', OTHER = '000002::备份合成账户'
const handles: OwnerWorkspace[] = []
const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function base(): OwnerSyncBaseline {
  return { pulledRevision: 3, records: [
    { key: KEY, kind: 'holding', deleted: false, record_revision: 3, lifecycle_revision: 1,
      field_revisions: { name: 1, shares: 3, cost: 1, target_weight: 1 },
      values: { name: '合成零份', shares: -0, cost: null, target_weight: 0 } },
    { key: OTHER, kind: 'watch', deleted: false, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 },
      values: { name: '合成归档关注', shares: null, cost: null, target_weight: null } },
    { key: 'asset:remote-removed', kind: 'manual_asset', deleted: true, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 1, cls: 1, value: 2, note: 1 }, values: { name: '合成旧现金', cls: '现金', value: -0, note: null } },
  ] }
}
async function fixture() {
  const factory = new IDBFactory(), controller = new AbortController()
  const guard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new Error('revoked') } }
  const v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const archive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'original opaque archive; never parsed or redacted',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '备份合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-22T00:00:00Z' }]) }
  const original = await buildOwnerLegacyWorkspaceBackup(archive)
  await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'portfolio-recovery-adopt',
    expected: await v3.readLocalState(guard), sourceArchive: archive, backupSha256: original.sha256 }), guard)
  const extra = await buildOwnerLegacyWorkspaceBackup({ sourceKey: 'sinan_watchlist_v2', v1Raw: null,
    v2Raw: canonicalOwnerLocal([{ code: '000002', name: '合成归档关注', account: '备份合成账户', position_kind: 'watch',
      shares: null, cost: null, target_weight: null, updated_at: '2026-10-21T01:00:00Z' }]) })
  const restored = await v3.restoreLocal(await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'portfolio-recovery-add-archive',
    expected: await v3.readLocalState(guard), backup: extra.envelope }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, restored, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'portfolio-recovery-link',
    expected: await v4.readSyncState(guard), base: base() }), guard)
  const v4State = await v4.readLocalState(guard)
  const source = { manualRaw: ' \n' + canonicalOwnerLocal([
    { id: 'x'.repeat(200), name: '合成零余额', cls: '现金', value: -0, updated_at: '2026-10-22T23:00:00Z' },
    { id: 'synthetic-gold', name: '合成商品', cls: '商品', value: 3, note: '', updated_at: '2026-10-22T23:00:00.12Z' },
  ]) + '\r\n', snapshotsRaw: canonicalOwnerLocal([
    { date: '2026-10-22', value: -0, cost: 0 },
    { date: '2026-10-22', value: 7, cost: 9, holdings: [{ id: 'opaque|original|not-current-identity', code: 'old-code',
      name: '原持仓', account: '原账户', type: '原类别', value: 7, cost: 9 }] },
  ]) }
  const upgradeFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, v4State, source)
  const upgrade = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'portfolio-recovery-upgrade',
    backupRaw: upgradeFile.raw, backupSha256: upgradeFile.sha256 })
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, upgrade, guard); handles.push(v5)
  const v5State = await v5.readLocalState(guard)
  await v5.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'portfolio-recovery-observation', expected: v5State,
    command: { type: 'append_observation', observation: { id: 'synthetic-balance-observation', kind: 'observation',
      observed_at: '2026-10-22T16:00:00Z', date: '2026-10-23', calendar: 'Asia/Shanghai', value: 3, cost: null,
      holdings: [{ kind: 'fund', key: KEY, name: '合成零份', type: '指数型', value: -0, cost: null },
        ...v5State.portfolio!.manual.map(item => ({ kind: 'manual' as const, key: item.key,
          name: item.values.name, cls: item.values.cls, value: item.values.value, cost: null }))] } } }), guard)
  return { factory, guard, v3State: restored, v4State, state: await v5.readLocalState(guard), source, upgradeFile, upgrade }
}
function copy<T>(input: T): T {
  return parseOwnerBusinessJson(canonicalOwnerLocal(input), OWNER_PORTFOLIO_RECOVERY_MAX_BYTES, 12) as T
}

describe('complete physical-v5 portfolio recovery file', () => {
  it('roundtrips an actual nonempty v5 image at shared JSON depth 12 without ambient IO', async () => {
    const current = await fixture(), forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    const built = await buildOwnerPortfolioRecoveryBackup(TARGET, current.state)
    expect(built.envelope).toEqual({ format: OWNER_PORTFOLIO_RECOVERY_FORMAT, physicalVersion: 5, targetFingerprint: TARGET, local: current.state })
    expect(built.sha256).toBe(hash(built.raw)); expect(built.byteLength).toBe(Buffer.byteLength(built.raw, 'utf8'))
    const recovered = await restoreOwnerPortfolioRecoveryBackup(built.raw, built.sha256)
    expect(recovered).toEqual(built.envelope)
    expect(recovered.local.metadata.restoredArchives).toHaveLength(1)
    expect(recovered.local.sync!.base).toEqual(base())
    expect(recovered.local.portfolioUpgrade).toEqual(current.state.portfolioUpgrade)
    expect(recovered.local.portfolioUpgrade!.backupSha256).toBe(current.upgradeFile.sha256)
    expect(recovered.local.portfolio!.migration.manualRaw).toBe(current.source.manualRaw)
    expect(recovered.local.portfolio!.migration.snapshotsRaw).toBe(current.source.snapshotsRaw)
    expect(recovered.local.portfolio!.history.map(item => item.date)).toEqual(['2026-10-22', '2026-10-22', '2026-10-23'])
    expect(recovered.local.portfolio!.history.map(item => item.cost)).toEqual([0, 9, null])
    expect(recovered.local.portfolio!.history[1].holdings![0]).toMatchObject({ id: 'opaque|original|not-current-identity' })
    expect(Object.is(recovered.local.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(Object.is(recovered.local.portfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(recovered.local.portfolio!.history[0].value, -0)).toBe(true)
    expect(recovered.local.portfolio!.manual[0].values.note).toBeNull()
    expect(Object.isFrozen(recovered.local.portfolio!.history[2].holdings![0])).toBe(true)
    expect(forbidden).not.toHaveBeenCalled()
  })

  it('takes an immutable input copy before the first asynchronous validator or hash', async () => {
    const current = await fixture(), input = copy(current.state) as any
    const pending = buildOwnerPortfolioRecoveryBackup(TARGET, input)
    input.portfolio.manual[1].values.value = 999
    input.metadata.adoption.sourceArchive.v1Raw = 'changed after call'
    const built = await pending
    expect(built.envelope.local.portfolio!.manual[1].values.value).toBe(3)
    expect(built.envelope.local.metadata.adoption!.sourceArchive.v1Raw).toBe(current.state.metadata.adoption!.sourceArchive.v1Raw)
  })

  it('never silently exports v3/v4 images or treats a v5 file as the older recovery format', async () => {
    const current = await fixture()
    await expect(buildOwnerPortfolioRecoveryBackup(TARGET, current.v3State)).rejects.toMatchObject({ code: 'invalid_recovery' })
    await expect(buildOwnerPortfolioRecoveryBackup(TARGET, current.v4State)).rejects.toMatchObject({ code: 'invalid_recovery' })
    const built = await buildOwnerPortfolioRecoveryBackup(TARGET, current.state)
    await expect(restoreOwnerWorkspaceRecoveryBackup(built.raw, built.sha256)).rejects.toBeInstanceOf(Error)
    for (const physicalVersion of [3, 4]) {
      const raw = canonicalOwnerLocal({ ...built.envelope, physicalVersion })
      await expect(restoreOwnerPortfolioRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
    }
    const raw = canonicalOwnerLocal({ ...built.envelope, format: 'sinan-owner-workspace-recovery-1' })
    await expect(restoreOwnerPortfolioRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
  })

  it('rejects resealed incompatible origin/history/adoption/intent/full-state fields', async () => {
    const { state } = await fixture(), built = await buildOwnerPortfolioRecoveryBackup(TARGET, state)
    const faults: Array<(input: any) => void> = [
      input => { input.local.portfolio.migration.sourceSha256 = 'a'.repeat(64) },
      input => { input.local.portfolio.migration.idMappings[0].legacyId = 'substitute' },
      input => { input.local.portfolio.manual.shift() },
      input => { input.local.portfolio.history.shift() },
      input => { input.local.portfolio.history[0].date = '2026-10-23' },
      input => { input.local.portfolio.history[1].holdings[0].id = 'changed opaque id' },
      input => { input.local.portfolio.history[2].cost = 3 },
      input => { input.local.portfolioUpgrade.hash = 'a'.repeat(64) },
      input => { input.local.portfolioUpgrade.sourceSha256 = 'a'.repeat(64) },
      input => { input.local.portfolioUpgrade.targetFingerprint = 'a'.repeat(64) },
      input => { delete input.local.portfolioUpgrade },
      input => { input.local.metadata.adoption.backupSha256 = 'a'.repeat(64) },
      input => { input.local.receiptCount = 1 },
      input => { delete input.local.sync },
      input => { input.local.outbox.entry = { schema: 'owner-sync-outbox-1', state: 'unknown', rawBody: '{}', requestHash: 'a'.repeat(64) } },
      input => { input.local.sync.pending = {} },
      input => { input.token = 'not-a-token' },
      input => { input.local.analysisTask = 'not-part-of-workspace-recovery' },
    ]
    for (const mutate of faults) {
      const input = copy(built.envelope); mutate(input)
      const raw = canonicalOwnerLocal(input)
      await expect(restoreOwnerPortfolioRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
    }
  })

  it('does not invoke nested getters or accept hidden/symbol/augmented object fields', async () => {
    const current = await fixture(), built = await buildOwnerPortfolioRecoveryBackup(TARGET, current.state), getter = vi.fn()
    const value = copy(built.envelope) as any
    Object.defineProperty(value.local.portfolio.manual[0].values, 'name', { get: getter, enumerable: true })
    await expect(validateOwnerPortfolioRecoveryBackup(value)).rejects.toBeInstanceOf(Error)
    expect(getter).not.toHaveBeenCalled()
    const hidden = { ...built.envelope }; Object.defineProperty(hidden, 'secret', { value: 'unread', enumerable: false })
    await expect(validateOwnerPortfolioRecoveryBackup(hidden)).rejects.toBeInstanceOf(Error)
    await expect(validateOwnerPortfolioRecoveryBackup({ ...built.envelope, [Symbol('hidden')]: true })).rejects.toBeInstanceOf(Error)
    const augmented = copy(built.envelope) as any; augmented.local.portfolio.manual.extra = true
    await expect(validateOwnerPortfolioRecoveryBackup(augmented)).rejects.toBeInstanceOf(Error)
  })

  it('rejects changed bytes, BOM, duplicate/escaped keys, unsafe integer and noncanonical whitespace', async () => {
    const current = await fixture(), built = await buildOwnerPortfolioRecoveryBackup(TARGET, current.state)
    await expect(restoreOwnerPortfolioRecoveryBackup(built.raw + '\n', built.sha256)).rejects.toMatchObject({ code: 'hash_mismatch' })
    const raws = ['\ufeff' + built.raw, built.raw + '\n', built.raw.replace('{', '{"physicalVersion":5,'),
      built.raw.replace('{', '{"\\u0070hysicalVersion":5,'), built.raw.replace('"receiptCount":0', '"receiptCount":9007199254740993')]
    for (const raw of raws) await expect(restoreOwnerPortfolioRecoveryBackup(raw, hash(raw))).rejects.toBeInstanceOf(Error)
    await expect(restoreOwnerPortfolioRecoveryBackup(built.raw, 'not-a-sha')).rejects.toMatchObject({ code: 'invalid_recovery' })
    await expect(restoreOwnerPortfolioRecoveryBackup('\ud800', 'a'.repeat(64))).rejects.toMatchObject({ code: 'invalid_recovery' })
  })

  it('enforces the exact UTF-8 24 MiB limit without trimming oversized files', async () => {
    const raw = ' '.repeat(OWNER_PORTFOLIO_RECOVERY_MAX_BYTES + 1)
    await expect(restoreOwnerPortfolioRecoveryBackup(raw, 'a'.repeat(64))).rejects.toMatchObject({ code: 'capacity_exceeded' })
    const unicode = '界'.repeat(Math.floor(OWNER_PORTFOLIO_RECOVERY_MAX_BYTES / 3) + 1)
    await expect(restoreOwnerPortfolioRecoveryBackup(unicode, 'a'.repeat(64))).rejects.toMatchObject({ code: 'capacity_exceeded' })
  })

  it('does not substitute a noncryptographic digest when the byte hash is unavailable', async () => {
    const current = await fixture(), built = await buildOwnerPortfolioRecoveryBackup(TARGET, current.state)
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('unavailable'))
    await expect(restoreOwnerPortfolioRecoveryBackup(built.raw, built.sha256)).rejects.toMatchObject({ code: 'hash_unavailable' })
  })
})
